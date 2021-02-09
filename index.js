const WebSocket = require("ws");
const {Pool: PostgresPool} = require('pg');
const Cookies = require('cookies');
const path = require('path');
const url = require('url');
const fs = require('fs');
const stream = require("stream");

PostgresPool.prototype.actualQueryForPeachServer = PostgresPool.prototype.query;

PostgresPool.prototype.query = async function (...args) {
	try {
		return await this.actualQueryForPeachServer(...args);
	} catch (err) {
		err.stack = (new Error(err.message)).stack;
		throw err;
	}
}

class PeachError extends Error {

	constructor(status, message, rootCause, peachCode) {
		super(message);
		this.status = status;
		this.rootCause = rootCause;
		this.peachCode = peachCode;
	}

}

class PeachOutput {

	constructor(data, contentType, code) {
		this.code = code;
		this.data = data;
		this.contentType = contentType;
	}

}

class PeachServer {

	constructor(properties) {

		this.cert = undefined;
		this.key = undefined;

		if (typeof properties === 'string') {
			try {
				properties = JSON.parse(fs.readFileSync(this.path, 'utf8'));
			} catch(err) {
				throw new Error('Could not read properties file during refresh');
			}
			properties = JSON.parse(fs.readFileSync(properties, {encoding: 'utf-8'}));
		}

		this.properties = properties;

		/** @type {PostgresPool[]} */
		this.dbPools = [];

		if (this.properties == null) {
			throw new Error('No properties file was provided');
		}

		if (Array.isArray(this.properties.databases)) {

			this.properties.databases.forEach((dataBaseProperties) => {

				const postgresOptions = {
					user: dataBaseProperties.username,
					password: dataBaseProperties.password,
					host: dataBaseProperties.host,
					database: dataBaseProperties.name,
					port: dataBaseProperties.port
				};

				if (dataBaseProperties.usessl) {
					postgresOptions.ssl = {
						rejectUnauthorized: false,
						key: this.getKey(),
						cert: this.getCert()
					};
				}

				this.dbPools.push(new PostgresPool(postgresOptions));

			});

		}

	}

	getCert () {
		if (this.cert === undefined) {
			if (this.properties.security == null || this.properties.security.cert == null) {
				throw new Error('No cert file path was provided');
			}
			try {
				this.cert = fs.readFileSync(this.properties.security.cert, 'utf8');
			} catch (err) {
				throw new Error('Could not read the cert file, an error occurred');
			}
		}
		return this.cert;
	}

	getKey () {
		if (this.key === undefined) {
			if (this.properties.security == null || this.properties.security.key == null) {
				throw new Error('No key file path was provided');
			}
			try {
				this.key = fs.readFileSync(this.properties.security.key, 'utf8');
			} catch (err) {
				throw new Error('Could not read the key file, an error occurred');
			}
		}
		return this.key;
	}

	getRequestInfo(req) {

		const acceptedHosts = Array.isArray(this.properties.server.acceptedhosts) ? this.properties.server.acceptedhosts : [];

		const proxyIsUsed = this.properties.server.trustedproxiessetxforwardedheaders && req.headers['x-proxy-secret'] != null && req.headers['x-proxy-secret'] === this.properties.server.xproxysecret;

		const proto = proxyIsUsed ? req.headers['x-forwarded-proto'] : (req.connection.encrypted ? 'https' : 'http');

		const rawHost = proxyIsUsed ? req.headers['x-forwarded-host'] : req.headers['host'];
		const host = acceptedHosts.includes(rawHost) ? rawHost : (acceptedHosts[0] || '');

		const origin = (host && proto) ? `${proto}://${host}` : (typeof this.properties.server.defaultorigin === 'string' ? this.properties.server.defaultorigin : '');

		let adjustedurl;
		let basepath;
		let basepaths = this.properties.server.basepaths;
		if (Array.isArray(basepaths)) {
			for (const testbasepath of basepaths) {
				if (req.url.startsWith(testbasepath)) {
					basepath = testbasepath;
					adjustedurl = req.url.substr(basepath.length);
					break;
				}
			}
			if (adjustedurl == null) {
				throw new PeachError(500, 'Request did not have an expected string at the beginning of the URL');
			}
		} else if (basepaths == null) {
			basepath = '';
			adjustedurl = req.url;
		} else {
			throw new PeachError(500, 'Improperly configured server for server.basepaths property');
		}

		const requrl = url.parse(`${origin}${adjustedurl}`, true);

		requrl.origin = requrl.protocol && requrl.host ? `${requrl.protocol}//${requrl.host}` : null;

		return {
			requrl,
			basepath,
			ip: null
		};

	}

	/**
	 * Start a new server with the requested options
	 * @param {object} input Input object containing information to create the server
	 * @param {(req: http.IncomingMessage, res: http.ServerResponse, requrl: url.UrlWithParsedQuery, basepath: string, ip: string, cookies: Cookies) => Promise<any>} input.requestListener The text that should be synthesised in speech
	 * @param {number} input.incrementPort The number to increment the port number by as specified in the properties file
	 * @param {string|null} input.authenticateMethod If a 401 or 403 error is thrown from inside the requestListener then this parameter to notify the user what authentication method they should perform
	 * @param {object|null} input.websocketData Data relating to the websocket server to be created
	 * @returns {void}
	 */
	start({
		requestListener,
		errorListener = null,
		authenticateMethod = 'Basic',
		incrementPort = 0,
		websocketData = null
	}) {

		if (typeof requestListener !== 'function') {
			throw new Error('A requestListener function must be passed');
		}

		const baseRequestListener = async (req, res) => {

			if (req.method === 'OPTIONS') {
				res.writeHead(200, {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Headers': req.headers['access-control-request-headers']
				});
				res.end();
				return;
			}

			let code = 200, data = '', contentType = 'text/plain', headers = {'Access-Control-Allow-Origin': '*'}, preventAutoResEnd = false;

			try {

				const {requrl, basepath, ip} = this.getRequestInfo(req);

				const output = await requestListener({
					req,
					res,
					requrl,
					basepath,
					ip,
					cookies: new Cookies(req, res, {
						secure: !(requrl.protocol === 'http:' && requrl.hostname === 'localhost')
					})
				});

				if (res._header == null) {

					if (output instanceof PeachOutput) {
						code = output.code || code;
						contentType = output.contentType || contentType;
						data = output.data || data;
					} else if (output === '' || output == null) {
						code = 204;
					} else if (typeof output === 'object') {
						if (output instanceof stream.Readable || output instanceof stream.Transform) {
							data = output;
						} else if (output instanceof Buffer) {
							data = output;
							contentType = 'text/html';
						} else {
							data = JSON.stringify(output);
							contentType = 'application/json';
						}
					} else if (typeof output === 'string') {
						data = output;
						contentType = 'text/html';
					} else {
						throw new PeachError(500, 'Unknown output type of request listener');
					}

					if (typeof contentType === 'string') {
						headers['Content-Type'] = contentType;
					}

					try {
						res.writeHead(code, headers);
					} catch(err) {
					}

					try {
						if (data instanceof stream.Readable || data instanceof stream.Transform) {
							data.pipe(res);
							preventAutoResEnd = true;
						} else {
							res.write(data);
						}
					} catch(err) {
						1 + 1;
					}

				}

			} catch(err) {

				console.error(err);
				code = 500;

				if (err instanceof PeachError) {
					if (Number.isInteger(err.status)) {
						code = err.status;
						if ((code === 401 || code === 403) && typeof authenticateMethod === 'string') {
							headers['WWW-Authenticate'] = authenticateMethod;
						}
					}
					data = err.message;
				}

				if (typeof errorListener === 'function') {

					const errorListenerOutput = await errorListener(req, err);

					if (errorListenerOutput.code != null) {
						code = errorListenerOutput.code;
					}
					if (errorListenerOutput.data != null) {
						data = errorListenerOutput.data;
					}
					if (errorListenerOutput.contentType != null) {
						contentType = errorListenerOutput.contentType;
					}
					if (errorListenerOutput.headers != null) {
						for (const headerName in errorListenerOutput.headers) {
							headers[headerName] = errorListenerOutput.headers[headerName]
						}
					}

					PeachServer.returnData(res, code, contentType, data, headers);

				} else if (errorListener != null && typeof errorListener === 'object' && errorListener[code] != null) {

					try {
						PeachServer.returnFile(res, code, errorListener[code], headers);
					} catch (err) {
						PeachServer.returnData(res, code, 'text/plain', `${code} caught error\n\n${data}`, headers);
					}

				} else {

					PeachServer.returnData(res, code, 'text/plain', `${code} error\n\n${data}`, headers);

				}

			} finally {

				if (!preventAutoResEnd) {
					res.end();
				}

			}

		};

		if (this.properties.server == null) {
			throw new Error('Server object in properties cannot be null');
		}

		if (!Number.isInteger(this.properties.server.port)) {
			throw new Error('Server port value in properties must be an integer');
		}

		let server;

		if (this.properties.server.usessl) {

			const https = require('https');

			server = https.createServer({
				key: this.getKey(),
				cert: this.getCert()
			}, baseRequestListener);

			server.listen(this.properties.server.port + incrementPort, '::');

		} else {

			const http = require('http');

			server = http.createServer(baseRequestListener);

			server.listen(this.properties.server.port + incrementPort, '::1');

		}

		if (typeof websocketData === 'object' && websocketData != null) {

			const wsServer = new WebSocket.Server({server});

			wsServer.on('connection', async (websocket, req) => {

				const sendMessage = (type, content) => {
					websocket.send(JSON.stringify({type, content}));
				}

				const terminate = () => {
					websocket.terminate(message);
				}

				const handleError = (err) => {
					let content;
					if (err instanceof PeachError) {
						content = {
							status: err.status,
							message: err.message,
							error_code: err.peachCode || null
						};
					} else {
						content = {
							status: 500,
							message: 'Server encountered an error during websocket connection',
							error_code: null
						};
					}
					sendMessage('error', content);
				}

				websocket.isAlive = true;
				websocket.on('pong', () => {
					websocket.isAlive = true;
				});

				const {requrl, basepath, ip} = this.getRequestInfo(req);

				if (typeof websocketData.onconnection === 'function') {
					websocketData.onconnection({
						req,
						sendMessage,
						terminate,
						handleError,
						requrl,
						basepath,
						ip,
						cookies: new Cookies(req, null, {
							secure: !(requrl.protocol === 'http:' && requrl.hostname === 'localhost')
						})
					}).catch((err) => {
						handleError(err);
						terminate();
					});
				}

			});

			const pingponginterval = setInterval(() => {
				for (const websocket of wsServer.clients) {
					if (websocket.isAlive) {
						websocket.isAlive = false;
						websocket.ping(() => {});
					} else {
						websocket.terminate();
					}
				}
			}, websocketData.pingPongTimeout || 30000);

			wsServer.on('close', () => {
				clearInterval(pingponginterval);
			});

		}

	}

	static getContentType(fileName) {
		const splitFileName = fileName.split('.');
		const extension = splitFileName[splitFileName.length - 1];
		switch(extension) {
			case 'html':
			return 'text/html';
			case 'css':
			return 'text/css';
			case 'json':
			return 'application/json';
			case 'js':
			return 'application/javascript';
			case 'ico':
			case 'png':
			return 'image/png';
			case 'jpg':
			case 'jpeg':
			return 'image/jpeg';
			case 'gif':
			return 'image/gif';
			case 'txt':
			return 'text/plain';
			case 'woff2':
			return 'font/woff2';
			case 'apng':
			return 'image/vnd.mozilla.apng';
		}
		console.error(`Unknown content type for "${extension}"`);
		return 'text/plain';
	}

	static returnData(res, code, contentType, data, headers = {}) {
		headers['Content-Type'] = contentType;
		headers['Access-Control-Allow-Origin'] = '*';
		res.writeHead(code, headers);
		res.write(data);
	}

	static getFile(folderPath, fileName, replacements) {
		let data;
		const folderPathTrailing = path.join(folderPath, path.sep)
		const fullPath = path.join(folderPathTrailing, fileName);
		if (fullPath !== folderPathTrailing + fileName) {
			throw new PeachError(404, 'Stop trying to snoop by traversing, eh?');
		}
		try {
			data = fs.readFileSync(fullPath);
		} catch (err) {
			throw new PeachError(404, `File not found: ${fullPath}`);
		}
		if (replacements == null) {
			return data;
		}
		data = data.toString('utf8');
		data = PeachServer.stringReplacements(data, replacements)
		return Buffer.from(data);
	}

	static stringReplacements(data, replacements) {
		for (const key in replacements) {
			data = data.replace(`{{${key}}}`, replacements[key]);
		}
		return data;
	}

	static returnFile(res, code, folderPath, fileName, headers = {}, replacements = undefined) {
		const contentType = PeachServer.getContentType(fileName, true);
		const data = PeachServer.getFile(folderPath, fileName, replacements);
		PeachServer.returnData(res, code, contentType, data, headers);
	}

	static assertPathLength(pathArray, length) {
		if (pathArray.length !== length) {
			throw new PeachError(404, 'Not Found: /' + pathArray.join('/'));
		}
	}

	static assertMethod(req, methods) {
		if (methods.includes(req.method)) {
			return req.method;
		}
		throw new PeachError(405, 'Invalid Verb');
	}

	static getRequestData(req, options = {}) {
		return new Promise((resolve, reject) => {
			try {
				let body = '';
				req.on('data', (data) => {
					body += data;
				});
				req.on('end', () => {
					if (options.json) {
						try {
							body = JSON.parse(body);
						} catch(err) {
							reject(new PeachError(400, `Expected JSON input: ${err.message}`));
							return;
						}
					}
					resolve(body);
				});
			} catch (err) {
				reject(err);
			}
		});
	}

}

module.exports.PeachServer = PeachServer;
module.exports.PeachError = PeachError;
module.exports.PeachOutput = PeachOutput;
