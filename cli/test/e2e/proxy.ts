import { connect, createServer, type Socket } from 'node:net';

/** A TCP proxy to the local Worker whose connections can all be cut at once. */
export async function startProxy(target = 8788) {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(target, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    cut: () => sockets.forEach((socket) => socket.destroy()),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
