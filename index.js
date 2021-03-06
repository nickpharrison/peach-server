import pg from 'pg';
import mime from 'mime';
import Cookies from 'cookies';
import path from 'path';
import url from 'url';
import fs from 'fs';
import qs from 'qs';
import stream from 'stream';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
export { default as WebSocket } from 'ws';

// Alter the query method on the pool and connection so that errors are handled with an actual readable stack trace to make debugging easier
pg.Pool.prototype.actualQueryForPeachServer = pg.Pool.prototype.query;
pg.Pool.prototype.query = async function (...args) {
	try {
		return await this.actualQueryForPeachServer(...args);
	} catch (err) {
		err.stack = (new Error(err.message)).stack;
		throw err;
	}
}
pg.Connection.prototype.actualQueryForPeachServer = pg.Connection.prototype.query;
pg.Connection.prototype.query = async function (...args) {
	try {
		return await this.actualQueryForPeachServer(...args);
	} catch (err) {
		err.stack = (new Error(err.message)).stack;
		throw err;
	}
}

mime.define({'image/vnd.mozilla.apng': ['apng']}, true);

const stringToBoolean = (string, def = undefined) => {
	if (typeof string !== 'string' || string === '') {
		return Boolean(def);
	}
	return string.toLowerCase() === 'true'
}

const makePeachPropertiesFromEnv = (prefix) => {

	const server = {
		port: parseInt(process.env[prefix + '_PORT'], 10),
		usessl: stringToBoolean(process.env[prefix + '_USESSL']),
		acceptedhosts: !process.env[prefix + '_ACCEPTEDHOSTS'] ? null : process.env[prefix + '_ACCEPTEDHOSTS'].split(';'),
		defaultorigin: process.env[prefix + '_DEFAULTORIGIN'],
		basepaths: !process.env[prefix + '_BASEPATHS'] ? null : process.env[prefix + '_BASEPATHS'].split(';'),
		xproxysecret: process.env[prefix + '_XPROXYSECRET'],
		trustedproxiessetxforwardedheaders: stringToBoolean(process.env[prefix + '_TRUSTEDPROXIESSETXFORWARDEDHEADER']),
		listenonlocalhostonly: stringToBoolean(process.env[prefix + '_LISTENONLOCALHOSTONLY']),
		listenonipv4only: stringToBoolean(process.env[prefix + '_LISTENONIPV4ONLY']),
	}

	const databases = !process.env[prefix + '_DATABASES'] ? [] : process.env[prefix + '_DATABASES'].split(';').map((x) => {
		const [username, password, host, name, port, usessl, extra] = x.split(',');
		if (usessl == null) {
			throw new Error(`Error parsing database env variables for prefix "${prefix}". Less than 6 parts were included.`);
		}
		if (extra != null) {
			throw new Error(`Error parsing database env variables for prefix "${prefix}". More than 6 parts were included.`);
		}
		return {
			username,
			password,
			host,
			name,
			port: parseInt(port, 10),
			usessl: stringToBoolean(usessl)
		}
	});

	const security = {
		cert: process.env[prefix + '_CERT'],
		key: process.env[prefix + '_CKEY'],
	}

	return {server, databases, security};

}

export class PeachError extends Error {

	/**
	 * 
	 * @param {number} status The HTTP status code of the error
	 * @param {string} message The message describing the error
	 * @param {object} other Other information about the error
	 * @param {string|number} other.errorcode A code specific to this error to allow the source of the error to be easily identifiable
	 * @param {Error} other.rootcause The error that caused this error to occur
	 * @param {object} other.headers The headers that should be sent in a HTTP response if this error is thrown all the way to the serevr level
	 */
	constructor(status, message, {errorcode, rootcause, headers = {}} = {}) {
		super(message);
		this.status = status;
		this.rootcause = rootcause;
		this.errorcode = errorcode;
		this.headers = headers;
	}

}

export class PeachOutput {

	/**
	 * 
	 * @param {number} status The HTTP status code for the repsonse
	 * @param {any} data The data for the HTTP response body
	 * @param {object} other Other information about the response
	 * @param {object} other.headers The headers to be sent in this HTTP response
	 */
	constructor(status, data, {headers = {}} = {}) {
		this.status = status;
		this.data = data;
		this.headers = headers;
	}

}

export class PeachFile {

	/**
	 * 
	 * @param {number} status The HTTP status code for the repsonse
	 * @param {string} folder The (unescapable) folder that the file is in
	 * @param {string} file The path of the file relative to the specified folder
	 * @param {object} other Other information about the response
	 * @param {{search: RegExp|string, replace: string}[]} other.replacements Replacements to perform on the file before sending it to the user. If search is a string, only the first occurance will be replaced. Note that specifying this results in the file being sent in a non-streaming manner
	 * @param {object} other.headers The headers that should be sent in a HTTP response
	 * @param {object} other.encoding The encoding the file should be read with
	 */
	constructor(status, folder, file, {replacements = null, headers = {}, encoding} = {}) {
		this.status = status;
		this.folder = folder;
		this.file = file;
		this.replacements = replacements;
		this.headers = headers;
		this.encoding = encoding;
	}

}

class PeachServerProperties {

	constructor({
		port,
		usessl,
		basepaths,
		acceptedhosts,
		trustedproxiessetxforwardedheaders,
		xproxysecret,
		listenonlocalhostonly,
		listenonipv4only
	}) {

		if (typeof port !== 'number' || !Number.isInteger(port) || port < 1) {
			throw new Error('Peach Properties server.port must be a positive integer');
		}
		this.port = port;

		if (typeof usessl !== 'boolean') {
			throw new Error('Peach Properties server.usessl must be a boolean');
		}
		this.usessl = usessl;

		if (basepaths == null) {
			this.basepaths = null;
		} else if (Array.isArray(basepaths)) {
			this.basepaths = basepaths.map((basepath) => {
				if (typeof basepath !== 'string') {
					throw new Error('Peach Properties server.basepaths contained a non-string value');
				}
				return basepath;
			})
		} else {
			throw new Error('Peach Properties server.basepaths must be an array or null');
		}

		if (acceptedhosts == null) {
			this.acceptedhosts = null;
		} else if (Array.isArray(acceptedhosts)) {
			this.acceptedhosts = acceptedhosts.map((host) => {
				if (typeof host !== 'string') {
					throw new Error('Peach Properties server.acceptedhosts contained a non-string value');
				}
				return host;
			})
		} else {
			throw new Error('Peach Properties server.acceptedhosts must be an array or null');
		}

		if (trustedproxiessetxforwardedheaders == null) {
			this.trustedproxiessetxforwardedheaders = false;
		} else if (typeof trustedproxiessetxforwardedheaders === 'boolean') {
			this.trustedproxiessetxforwardedheaders = trustedproxiessetxforwardedheaders;
		} else {
			throw new Error('Peach Properties server.trustedproxiessetxforwardedheaders must be a boolean');
		}

		if (typeof xproxysecret === 'string') {
			this.xproxysecret = xproxysecret;
		} else if (xproxysecret != null) {
			throw new Error('Peach Properties server.xproxysecret must be a boolean');
		} else if (this.trustedproxiessetxforwardedheaders) {
			throw new Error('Peach Properties server.xproxysecret must be a string if server.trustedproxiessetxforwardedheaders is true');
		} else {
			this.xproxysecret = null;
		}

		if (listenonlocalhostonly == null) {
			this.listenonlocalhostonly = !this.usessl;
		} else if (typeof listenonlocalhostonly === 'boolean') {
			this.listenonlocalhostonly = listenonlocalhostonly;
		} else {
			throw new Error('Peach Properties server.listenonlocalhostonly must be a boolean');
		}

		if (listenonipv4only == null) {
			this.listenonipv4only = false;
		} else if (typeof listenonipv4only === 'boolean') {
			this.listenonipv4only = listenonipv4only;
		} else {
			throw new Error('Peach Properties server.listenonipv4only must be a boolean');
		}

	}

}

class PeachDatabaseProperties {

	constructor({
		username,
		password,
		host,
		name,
		port,
		usessl
	}) {

		if (typeof username !== 'string') {
			throw new Error('Peach Properties databases[].username must be a string');
		}
		this.username = username;

		if (typeof password !== 'string') {
			throw new Error('Peach Properties databases[].password must be a string');
		}
		this.password = password;

		if (typeof host !== 'string') {
			throw new Error('Peach Properties databases[].host must be a string');
		}
		this.host = host;

		if (typeof name !== 'string') {
			throw new Error('Peach Properties databases[].name must be a string');
		}
		this.name = name;

		if (typeof port !== 'number' || !Number.isInteger(port) || port < 1) {
			throw new Error('Peach Properties databases[].port must be a positive integer');
		}
		this.port = port;

		if (typeof usessl !== 'boolean') {
			throw new Error('Peach Properties databases[].usessl must be a boolean');
		}
		this.usessl = usessl;

	}

}

class PeachSecurityProperties {

	constructor({
		cert,
		key
	}) {

		if (typeof cert === 'string') {
			this.cert = cert;
		} else if (cert == null) {
			this.cert = null;
		} else {
			throw new Error('Peach Properties security.cert must be a string or null');
		}

		if (typeof key === 'string') {
			this.key = key;
		} else if (key == null) {
			this.key = null;
		} else {
			throw new Error('Peach Properties security.key must be a string or null');
		}

	}

}

export class PeachProperties {

	constructor({
		server,
		databases,
		security
	}) {
		this.server = new PeachServerProperties(server ?? {});
		if (databases == null) {
			databases = [];
		}
		if (!Array.isArray(databases)) {
			throw new Error('Peach Properties databases must be an array or null');
		}
		this.databases = databases.map(x => new PeachDatabaseProperties(x ?? {}));
		this.security = new PeachSecurityProperties(security ?? {});
	}

}

export const PeachManualClose = Symbol('PEACH_SYNC_MANUAL_CLOSE');

export class PeachServer {

	constructor(properties) {

		this._cert = null;
		this._key = null;
		//this._dbpools = null;

		if (typeof properties === 'string') {
			if (properties === 'env') {
				properties = makePeachPropertiesFromEnv('PS');
			} else if (properties.startsWith('env:')) {
				properties = makePeachPropertiesFromEnv(properties.split(':')[1]);
			} else {
				properties = JSON.parse(fs.readFileSync(properties, {encoding: 'utf-8'}));
			}
		}
		this.properties = new PeachProperties(properties);

	}

	/**
	 * Get the database pools as specified in the properties
	 * @returns {Promise<pg.Pool[]>}
	 */
	async getDbPools() {
		if (this._dbpools == null) {
			this._dbpools = await Promise.all(this.properties.databases.map(async x =>  new pg.Pool({
				user: x.username,
				password: x.password,
				host: x.host,
				database: x.name,
				port: x.port,
				ssl: !x.usessl ? undefined : {
					rejectUnauthorized: false,
					cert: await this.getCert(),
					key: await this.getKey()
				}
			})));
		}
		return this._dbpools;
	}

	/**
	 * Get the database pools as specified in the properties
	 * @returns {pg.Pool[]}
	 */
	getDbPoolsSync() {
		if (this._dbpools == null) {
			return this.properties.databases.map(x =>  new pg.Pool({
				user: x.username,
				password: x.password,
				host: x.host,
				database: x.name,
				port: x.port,
				ssl: !x.usessl ? undefined : {
					rejectUnauthorized: false,
					cert: this.getCertSync(),
					key: this.getKeySync()
				}
			}));
		}
		return this._dbpools;
	}

	/**
	 * Get the certificate file for the server
	 * @returns {Promise<Buffer>}
	 */
	async getCert() {
		if (this._cert == null) {
			if (this.properties.security.cert == null) {
				throw new Error('No cert file path was provided in Peach properties file');
			}
			this._cert = await fs.promises.readFile(this.properties.security.cert);
		}
		return this._cert;
	}

	/**
	 * Get the cert file for the server
	 * @returns {Buffer}
	 */
	getCertSync() {
		if (this._cert == null) {
			if (this.properties.security.cert == null) {
				throw new Error('No cert file path was provided in Peach properties file');
			}
			this._cert = fs.readFileSync(this.properties.security.cert);
		}
		return this._cert;
	}

	/**
	 * Get the key file for the server
	 * @returns {Promise<Buffer>}
	 */
	async getKey() {
		if (this._key == null) {
			if (this.properties.security.key == null) {
				throw new Error('No key file path was provided in Peach properties file');
			}
			this._key = await fs.promises.readFile(this.properties.security.key);
		}
		return this._key;
	}

	/**
	 * Get the key file for the server
	 * @returns {Buffer}
	 */
	getKeySync() {
		if (this._key == null) {
			if (this.properties.security.key == null) {
				throw new Error('No key file path was provided in Peach properties file');
			}
			this._key = fs.readFileSync(this.properties.security.key);
		}
		return this._key;
	}

	/**
	 * Get information about the request to pass to the request listener
	 * @param {http.IncomingMessage} req HTTP request object
	 */
	getRequestInfo(req) {

		const acceptedHosts = this.properties.server.acceptedhosts;

		const proxyIsUsed = this.properties.server.trustedproxiessetxforwardedheaders && req.headers['x-proxy-secret'] != null && req.headers['x-proxy-secret'] === this.properties.server.xproxysecret;

		/** @type {"http"|"https"} */
		const proto = proxyIsUsed ? req.headers['x-forwarded-proto'] : (req.connection.encrypted ? 'https' : 'http');
		if (proto !== 'https' && proto !== 'http') {
			throw new PeachError(400, `An unrecognised protocol "${proto}" was used`);
		}

		/** @type {string} */
		const host = proxyIsUsed ? req.headers['x-forwarded-host'] : req.headers['host'];
		if (acceptedHosts != null && !acceptedHosts.includes(host)) {
			throw new PeachError(400, `An unsupported host "${host}" was used`);
		}

		const origin = proto + '://' + host;

		let adjustedurl;
		let basepath;
		const basepaths = this.properties.server.basepaths;
		if (basepaths == null) {
			basepath = '';
			adjustedurl = req.url;
		} else {
			for (const testbasepath of basepaths) {
				if (req.url.startsWith(testbasepath)) {
					basepath = testbasepath;
					adjustedurl = req.url.substr(basepath.length);
					break;
				}
			}
			if (adjustedurl == null) {
				throw new PeachError(400, 'Request did not have an expected string at the beginning of the URL');
			}
		}

		const requrl = url.parse(`${origin}${adjustedurl}`, true);

		return {
			requrl,
			basepath,
			ip: null
		};

	}

	/**
	 * Start a new server with the requested options
	 * @param {object} input Input object containing information to create the server
	 * @param {({req, res, requrl, basepath, ip, cookies}: {req: http.IncomingMessage, res: http.ServerResponse, requrl: url.UrlWithParsedQuery, basepath: string, ip: string, cookies: Cookies}) => Promise<any>} input.requestListener The function that gets called whenever a new request is received
	 * @param {number} input.incrementPort The number to increment the port number by as specified in the properties file
	 * @param {string|null} input.authenticateMethod If a 401 or 403 error is thrown from inside the requestListener then this parameter to notify the user what authentication method they should perform
	 * @param {object} input.websocketData Data relating to the websocket server to be created
	 * @param {({req, websocket, sendMessage, terminate, handleError, requrl, basepath, ip, cookies}: {req: http.IncomingMessage, websocket: WebSocket, sendMessage: (type: string, content: any) => void, terminate: () => void, handleError: (err: any) => void, requrl: url.UrlWithParsedQuery, basepath: string, ip: string, cookies: Cookies}) => Promise<void>} input.websocketData.onConnection The function to be called on a websocket connection
	 * @param {number} input.websocketData.pingPongTimeout The number of milliseconds to wait in the "ping pong loop" for detcting dead connections
	 */
	start({
		requestListener,
		authenticateMethod = 'Basic',
		incrementPort = 0,
		allowAllCors = true,
		websocketData = null
	}) {

		if (typeof requestListener !== 'function') {
			throw new Error('A requestListener function must be passed');
		}

		/**
		 * @param {http.IncomingMessage} req 
		 * @param {http.ServerResponse} res 
		 */
		const baseRequestListener = async (req, res) => {

			let status, data, doStream = false, bypassFinally = false, clientresponsibleforclosingres = false, headers = {};

			if (allowAllCors) {
				headers['Access-Control-Allow-Origin'] = '*';
				if (req.method === 'OPTIONS') {
					if (req.headers['access-control-request-headers']) {
						headers['Access-Control-Allow-Headers'] = req.headers['access-control-request-headers'];
					}
					res.writeHead(204, headers);
					res.end();
					return;
				}
			}

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

				if (output === PeachManualClose) {
					bypassFinally = true;
					return;
				}

				// If a header has already been written
				if (res._header != null) {
					bypassFinally = true;
					return;
				}

				// Extract the information from PeachOutput and PeachFile
				if (output instanceof PeachOutput) {
					status = output.status;
					Object.assign(headers, output.headers);
					data = output.data;
				} else if (output instanceof PeachFile) {
					status = output.status;
					Object.assign(headers, output.headers);
					const absFolderPath = path.resolve(output.folder);
					const fullPath = path.join(absFolderPath, output.file);
					if (fullPath !== absFolderPath + path.sep + output.file) {
						throw new PeachError(404, 'Stop trying to snoop by traversing, eh?');
					}
					if (output.replacements == null) {
						data = fs.createReadStream(fullPath, {encoding: output.encoding ?? undefined});
					} else {
						try {
							data = await fs.promises.readFile(fullPath, {encoding: output.encoding ?? 'utf-8'});
						} catch (err) {
							if (err.code === 'ENOENT') {
								throw new PeachError(404, 'Not found');
							}
							throw err;
						}
						for (const {search, replace} of output.replacements) {
							data = data.replace(search, replace);
						}
					}
					if (!headers['Content-Type']) {
						const contentType = this.constructor.getContentType(fullPath);
						if (contentType != null) {
							headers['Content-Type'] = contentType;
						}
					}
				} else {
					data = output;
				}

				// Set the status code (if not already)
				if (typeof status !== 'number') {
					status = data == null ? 204 : 200;
				}

				// Alter the data to to make it http-friendly
				if (data == null) {
					data = '';
				} else if (data instanceof stream.Readable || data instanceof stream.Transform) {
					doStream = true;
				} else if (typeof data === 'object') {
					data = JSON.stringify(data);
					if (!headers['Content-Type']) {
						headers['Content-Type'] = 'application/json';
					}
				}

			} catch(err) {

				status = 500;

				console.error(err);

				let errorcode, message;

				if (err instanceof PeachError) {
					if (Number.isInteger(err.status)) {
						status = err.status;
					}
					message = err.message;
					errorcode = err.errorcode;
					Object.assign(headers, err.headers);
				} else if (err instanceof Error) {
					message = err.message;
				} else {
					message = 'An error occurred whilst processing your request'
				}

				if (errorcode == null) {
					errorcode = null;
				}

				if (!headers['WWW-Authenticate'] && typeof authenticateMethod === 'string' && [401, 403].includes(status)) {
					headers['WWW-Authenticate'] = authenticateMethod;
				}


				if (status >= 300 && status < 400) {
					data = message;
				} else {
					if (status < 400 || status >= 500) {
						message = null;
					}
					headers['Content-Type'] = 'application/json';
					data = JSON.stringify({status, errorcode, message});
				}

				doStream = false;

			} finally {

				if (!bypassFinally) {

					if (status >= 300 && status < 400) {
						if (!headers['Location']) {
							headers['Location'] = data;
						}
						data = '';
						doStream = false;
					}
	
					try {
						if (doStream) {
							clientresponsibleforclosingres = true;
							if (data instanceof fs.ReadStream) {
								data.on('open', () => {
									res.writeHead(status, headers);
									data.pipe(res);
								});
								data.on('error', () => {
									headers['Content-Type'] = 'application/json';
									res.writeHead(404, headers);
									res.write(JSON.stringify({status: 404, errorcode: 99264, message: 'Not found'}));
								});
							} else {
								res.writeHead(status, headers);
								data.pipe(res);
							}
						} else {
							res.writeHead(status, headers);
							res.write(data);
						}
					} catch (err) {
						console.error('PeachServer error while writing to res:', err);
					} finally {
						if (!clientresponsibleforclosingres) {
							res.end();
						}
					}
	
				}

			}

		}

		let server;
		if (this.properties.server.usessl) {
			server = https.createServer({
				cert: this.getCertSync(),
				key: this.getKeySync()
			}, baseRequestListener);
		} else {
			server = http.createServer(baseRequestListener);
		}

		let listenon;
		if (this.properties.server.listenonlocalhostonly) {
			listenon = this.properties.server.listenonipv4only ? '127.0.0.1' : '::1';
		} else {
			listenon = this.properties.server.listenonipv4only ? '0.0.0.0' : '::';
		}

		server.listen(this.properties.server.port + incrementPort, listenon);

		if (typeof websocketData === 'object' && websocketData != null) {

			const wsServer = new WebSocket.Server({server});

			wsServer.on('connection', (websocket, req) => {

				const sendMessage = (type, content) => {
					websocket.send(JSON.stringify({type, content}));
				}

				const terminate = () => {
					websocket.terminate();
				}

				const handleError = (err) => {
					console.error(err);
					let content;
					if (err instanceof PeachError) {
						content = {
							status: err.status,
							message: err.message,
							error_code: err.errorcode ?? null
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

				if (typeof websocketData.onConnection === 'function') {
					try {
						const output = websocketData.onConnection({
							req,
							websocket,
							sendMessage,
							terminate,
							handleError,
							requrl,
							basepath,
							ip,
							cookies: new Cookies(req, null, {
								secure: !(requrl.protocol === 'http:' && requrl.hostname === 'localhost')
							})
						});
						if (output instanceof Promise) {
							output.catch((err) => {
								handleError(err);
								terminate();
							});
						}
					} catch (err) {
						handleError(err);
						terminate();
					}
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
			}, websocketData.pingPongTimeout ?? 30000);

			wsServer.on('close', () => {
				clearInterval(pingponginterval);
			});

		}

	}

	/**
	 * Return the content type of a file
	 * @param {string} string A file name/path/extension to get the content type of
	 * @returns {string} The MIME Content Type of the related file
	 */
	static getContentType(string) {
		const contentType = mime.getType(string);
		if (contentType) {
			return contentType;
		}
		console.log(`No content type could be determined for "${string}"`);
	}

	/**
	 * Throw a 404 error if the path of a request has too many or too few parts
	 * @param {string[]} pathArray The path array of the request
	 * @param {number} length The expected number of objects in the path array
	 * @returns {void}
	 */
	static assertPathLength(pathArray, length) {
		if (pathArray.length !== length) {
			throw new PeachError(404, 'Not Found: /' + pathArray.join('/'));
		}
	}

	/**
	 * Throw a 405 error if the method of a HTTP request is not allowed
	 * @param {http.IncomingMessage} req The http request object
	 * @param {string[]} methods A list of acceptable methods to allow
	 * @returns {string} The method of the request
	 */
	static assertMethod(req, methods) {
		if (methods.includes(req.method)) {
			return req.method;
		}
		throw new PeachError(405, 'Invalid Verb');
	}

	/**
	 * Return (and wait for) the body of a request
	 * @param {http.IncomingMessage} req The http request object
	 * @param {object} options Options
	 * @param {number} options.maxBodySize The maximum body size (in bytes) to accept before throwing a 413 (default 10000000)
	 * @param {boolean} options.json Whether to parse the body of the response into an object and resolve the promise as that instead
	 * @returns {Promise<string|object>} If options.json is false, a string of the body. If options.json is true, the parsed object representing the body
	 */
	static getRequestData(req, options = {}) {
		return new Promise((resolve, reject) => {
			try {
				const maxBodySize = options.maxBodySize ?? 10000000; 
				let body = '';
				let stoppedProcessing = false;
				req.on('data', (data) => {
					if (stoppedProcessing) {
						return;
					}
					body += data;
					if (body.length > maxBodySize) {
						stoppedProcessing = true;
						reject(new PeachError(413, 'Request body exceeded maximum length'));
					}
				});
				req.on('end', () => {
					if (stoppedProcessing) {
						return;
					}
					if (options.json) {
						switch (req.headers['content-type']) {
							case 'application/json':
								try {
									body = JSON.parse(body);
								} catch(err) {
									reject(new PeachError(400, err.message ?? 'Error parsing JSON'));
									return;
								}
								break;
							case 'application/x-www-form-urlencoded':
								body = qs.parse(body);
								break;
							default:
								reject(new PeachError(400, `Cannot parse content type "${req.headers['content-type']}"`));
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
