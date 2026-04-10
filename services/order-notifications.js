function buildNotificationEvents(previousOrder, nextOrder, trigger) {
  if (!nextOrder) {
    return [];
  }

  const previous = previousOrder || {};
  const events = [];

  if (previous.status !== nextOrder.status) {
    events.push({
      type: "pedido_status_atualizado",
      trigger,
      pedidoId: nextOrder.id,
      de: previous.status || null,
      para: nextOrder.status
    });
  }

  if (previous.statusPagamento !== nextOrder.statusPagamento) {
    events.push({
      type: "pedido_pagamento_atualizado",
      trigger,
      pedidoId: nextOrder.id,
      de: previous.statusPagamento || null,
      para: nextOrder.statusPagamento
    });
  }

  if ((previous.codigoRastreio || "") !== (nextOrder.codigoRastreio || "") && nextOrder.codigoRastreio) {
    events.push({
      type: "pedido_rastreio_atualizado",
      trigger,
      pedidoId: nextOrder.id,
      codigoRastreio: nextOrder.codigoRastreio
    });
  }

  return events;
}

async function handleOrderNotifications(change) {
  const events = buildNotificationEvents(change.previousOrder, change.nextOrder, change.trigger);

  if (!events.length) {
    return [];
  }

  // Ponto preparado para futuro envio real de e-mail, WhatsApp ou fila assíncrona.
  console.info("[notificacoes:pedido:pendente]", JSON.stringify(events));
  return events;
}

module.exports = {
  buildNotificationEvents,
  handleOrderNotifications
};
