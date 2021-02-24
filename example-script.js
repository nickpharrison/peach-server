
import {PeachServer, PeachError, PeachOutput, PeachFile} from './index.js';

const peachServer = new PeachServer('example-properties.json');

const dbPool = (await peachServer.getDbPools())[0];
const properties = peachServer.properties;

peachServer.start({
	requestListener: async ({req, res, requrl, query}) => {

		switch (requrl.path) {

			case '/object': // Note the object is automatically converted to JSON and the appropriate content type is set
				return {
					foo: 'bar',
					yay: 'nah'
				};

			case '/string': // Note the no content type is set, so a PeachOutput should be used instead
				return 'I see you know your judo well';

			case '/html': // Note the content type is automatically sent based on the file extension
				return new PeachFile(200, '.', 'test.html', {
					encoding: 'utf-8',
					replacements: [
						{search: /{{ADJ}}/g, replace: 'great'},
						{search: /is/g, replace: 'at'}
					]
				});

			case '/manual':
				return new PeachOutput(202, '<html><head><title>PEACHY</title></head><body>Maybe... Who knows..?</body></html>', {
					headers: {
						'Content-Type': 'text/html',
						'XXX-My-Head': 'BBB'
					}
				});

			case '/query':
				return (await dbPool.query('SELECT * FROM my_table WHERE id = $1;', [42])).rows;

			case '/404':
				throw new PeachError(404, 'Where\'d it go?', {errorcode: 36425629});

			case '/undefined':
				const myvar = 'testtesttest' + unknownvar;
				return myvar;

		}

	}
});
