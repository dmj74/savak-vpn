/** Wait for a datagram socket to be readable via .address() (bind(0) is async). */
export function portOf(socket) {
  const ready = () => {
    try {
      const a = socket.address();
      return a?.port ? a.port : null;
    } catch {
      return null; // still binding
    }
  };
  return new Promise((resolve, reject) => {
    const immediate = ready();
    if (immediate) return resolve(immediate);
    const timer = setTimeout(() => {
      const p = ready();
      p ? resolve(p) : reject(new Error('socket never bound'));
    }, 250);
    socket.once('listening', () => {
      clearTimeout(timer);
      resolve(ready());
    });
  });
}
