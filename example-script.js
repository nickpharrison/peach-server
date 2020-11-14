
const path = require('path');

const {PeachServer, PeachError} = require('./index.js');

const peachServer = new PeachServer({
	peachPropertiesPath: path.join(__dirname, '/example-properties.json')
});

const dbPool = peachServer.dbPools[0];
const properties = peachServer.properties;

const requestListener = async ({req, res, pathArray, query}) => {

	switch (pathArray[0]) {
		case 'object':
			return {
				foo: 'bar',
				yay: 'nah'
			};
		case 'string':
			return '<html><head><title>p e a c h y</title></head><body>yeet</body></html>';
		case 'manual':
			PeachServer.returnData(res, 402, 'text/plain', 'pay me!', {'XXX-My-Head': 'BBB'});
			return;
		case 'error':
			throw new PeachError(404, 'Where\'d it go?');
	}

}

peachServer.start({requestListener});
