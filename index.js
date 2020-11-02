const {Pool: PostgresPool} = require('pg');
const url = require('url');
const qs = require('qs');
const fs = require('fs');

let http, https;

const getServerModule = (serverType) => {
	if (serverType === 'http') {
		if (http === undefined) {
			http = require('http');
		}
		return http;
	}
	if (serverType === 'https') {
		if (https === undefined) {
			https = require('https');
		}
		return https;
	}
	throw new Error('Can only fetch http or https module');
}

class PeachProperties {

	constructor(propertiesPath) {
		this.path = propertiesPath;
		this.refreshProperties();
	}

	refreshProperties() {
		let propertiesString;
		try {
			propertiesString = fs.readFileSync(this.path, 'utf8');
		} catch(err) {
			throw new Error('Could not read properties file during refresh');
		}
		this.data = JSON.parse(propertiesString);
	}

}

class PeachError extends Error {

	constructor(status, message, peachCode = null) {
		super(message);
		this.status = status;
		this.peachCode = peachCode;
	}

}

class PeachServer {

	constructor({
		peachPropertiesPath,
	}) {

		this.cert = undefined;
		this.key = undefined;

		this.properties = new PeachProperties(peachPropertiesPath);

		const postgresOptions = {
			user: this.properties.data.database.username,
			password: this.properties.data.database.password,
			host: this.properties.data.database.host,
			database: this.properties.data.database.name,
			port: this.properties.data.database.port
		};
		
		if (this.properties.data.database.usessl) {
			postgresOptions.ssl = {
				rejectUnauthorized: false,
				key: this.getKey(),
				cert: this.getCert()
			};
		} else if (this.properties.data.database.host !== 'localhost') {
			throw new Error(500, 'Must use an SSL encryption for non-localhost DB connections. Edit the server properties file.');
		}
	
		this.dbPool = new PostgresPool(postgresOptions);

	}

	getCert () {
		if (this.cert === undefined) {
			if (this.properties.data.security == null || this.properties.data.security.cert == null) {
				throw new Error('No cert file path was provided');
			}
			try {
				this.cert = fs.readFileSync(this.properties.data.security.cert, 'utf8');
			} catch (err) {
				throw new Error(`Could not read the cert file, an error occurred`);
			}
		}
		return this.cert;
	}

	getKey () {
		if (this.key === undefined) {
			if (this.properties.data.security == null || this.properties.data.security.key == null) {
				throw new Error('No key file path was provided');
			}
			try {
				this.key = fs.readFileSync(this.properties.data.security.key, 'utf8');
			} catch (err) {
				throw new Error(`Could not read the key file, an error occurred`);
			}
		}
		return this.key;
	}

	start({
		requestListener,
		errorListener = null,
		authenticateMethod = 'Basic'
	}) {
			
		const baseRequestListener = async (req, res) => {

			let code = 200, data = '', contentType = 'text/plain', headers = {};

			try {

				const output = await requestListener({
					req,
					res,
					pathArray: url.parse(req.url).pathname.replace(/^\/|\/$/g, '').split('/'),
					query: qs.parse(url.query)
				});

				if (!res.finished && output !== undefined) {

					if (output === '' || output == null) {
						code = 204;
					} else if (typeof output === 'object') {
						if (output instanceof Buffer) {
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

					headers['Content-Type'] = contentType;

					try {
						res.writeHead(200, headers);
					} catch(err) {
					}

					try {
						res.write(data);
					} catch(err) {
					}

				}

			} catch(err) {
				console.error(err);
				code = 500;

				if (err instanceof PeachError) {
					if (Number.isInteger(err.status)) {
						code = err.status;
						if (code === 401 || code === 403) {
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

				res.end();

			}
		
		}

		if (this.properties.data.server.usessl) {

			const https = getServerModule('https');

			const httpsServer = https.createServer({
				key: this.getKey(),
				cert: this.getCert()
			}, baseRequestListener);

			httpsServer.listen(this.properties.data.server.port, '::');

		} else {

			const http = getServerModule('http');

			const httpServer = http.createServer(baseRequestListener);

			httpServer.listen(this.properties.data.server.port, '::1');

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
			case 'gif':
			return 'image/gif';
			case 'txt':
			return 'text/plain';
		}
		console.error(`Unknown content type for "${extension}"`);
		return 'text/plain';
	}

	static returnData(res, code, contentType, data, headers = {}) {
		headers['Content-Type'] = contentType;
		res.writeHead(code, headers);
		res.write(data);
	}

	static getFile(filePath, replacements) {
		let data;
		try {
			data = fs.readFileSync(filePath);
		} catch (err) {
			throw new PeachError(404, 'File not found');
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

	static returnFile(res, code, filePath, headers = {}, replacements = undefined) {
		const contentType = PeachServer.getContentType(fileName, true);
		const data = PeachServer.getFile(filePath, replacements);
		PeachServer.returnData(res, code, contentType, data, headers);
	}

}

exports.PeachServer = PeachServer;
exports.PeachError = PeachError;
