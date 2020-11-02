
const {PeachServer, PeachError} = require('./index.js');

const peachServer = new PeachServer({
	peachPropertiesPath: 'C:/Users/Nick/Documents/GitHub/peach-server/example-properties.json'
});

const dbPool = peachServer.dbPool;
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
			PeachServer.returnData(res, 202, 'text/plain', 'pay me!', {'XXX-My-Head': 'BBB'});
			return;
		case 'error':
			throw new PeachError(404, 'Where\'d it go?');
	}

}

peachServer.start({requestListener});
