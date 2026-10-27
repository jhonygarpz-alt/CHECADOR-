/**
 * Canal de tiempo real con Server-Sent Events. Los administradores reciben todos los eventos;
 * cada empleado solo los suyos.
 */
export class Realtime {
  clients = new Set();

  connect(req, res, user) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const client = { res, user };
    this.clients.add(client);
    send(res, 'hello', { now: new Date().toISOString() });

    const heartbeat = setInterval(() => send(res, 'tick', { now: new Date().toISOString() }), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    });
  }

  publish(event, data, { userId } = {}) {
    for (const { res, user } of this.clients) {
      if (user.role === 'admin' || user.id === userId) send(res, event, data);
    }
  }
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
