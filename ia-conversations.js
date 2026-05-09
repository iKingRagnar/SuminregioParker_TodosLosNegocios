'use strict';

var sumiDb = require('./sumi-db');
var COLL = 'ia_conversations';

function install(app) {
  var express = require('express');
  var json = express.json({ limit: '2mb' });

  function userId(req) {
    if (req.user && req.user.email) return req.user.email;
    if (req.session && req.session.user && req.session.user.email) return req.session.user.email;
    return 'anon';
  }

  app.get('/api/ia/conversations', function (req, res) {
    var uid = userId(req);
    var all = sumiDb.query(COLL, { userId: uid });
    var list = all.map(function (c) {
      return { id: c.id, title: c.title || 'Sin título', dbId: c.dbId || '', msgCount: (c.messages || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt || c.createdAt };
    });
    list.sort(function (a, b) { return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''); });
    res.json({ ok: true, conversations: list });
  });

  app.get('/api/ia/conversations/:id', function (req, res) {
    var uid = userId(req);
    var all = sumiDb.query(COLL, { userId: uid });
    var conv = all.find(function (c) { return c.id === req.params.id; });
    if (!conv) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true, conversation: conv });
  });

  app.post('/api/ia/conversations', json, function (req, res) {
    var uid = userId(req);
    var body = req.body || {};
    var conv = sumiDb.append(COLL, {
      userId: uid,
      title: body.title || 'Nueva conversación',
      dbId: body.dbId || '',
      messages: body.messages || [],
    });
    res.json({ ok: true, conversation: conv });
  });

  app.put('/api/ia/conversations/:id', json, function (req, res) {
    var uid = userId(req);
    var existing = sumiDb.query(COLL, { userId: uid }).find(function (c) { return c.id === req.params.id; });
    if (!existing) return res.status(404).json({ error: 'No encontrada' });
    var patch = {};
    if (req.body.title !== undefined) patch.title = req.body.title;
    if (req.body.messages !== undefined) patch.messages = req.body.messages;
    if (req.body.dbId !== undefined) patch.dbId = req.body.dbId;
    var updated = sumiDb.update(COLL, req.params.id, patch);
    res.json({ ok: true, conversation: updated });
  });

  app.delete('/api/ia/conversations/:id', function (req, res) {
    var uid = userId(req);
    var existing = sumiDb.query(COLL, { userId: uid }).find(function (c) { return c.id === req.params.id; });
    if (!existing) return res.status(404).json({ error: 'No encontrada' });
    sumiDb.remove(COLL, req.params.id);
    res.json({ ok: true });
  });
}

module.exports = { install: install };
