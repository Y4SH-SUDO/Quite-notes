self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const client = clients.find(item => 'focus' in item);
    if (client) return client.focus();
    return self.clients.openWindow('./');
  }));
});
