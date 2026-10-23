import { createDemoServer } from './service.js';

const server = createDemoServer();

server.on('error', (error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(3000, '127.0.0.1', () => {
  console.log('Demo server listening on http://127.0.0.1:3000');
});

function shutdown(): void {
  server.close();
  server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
