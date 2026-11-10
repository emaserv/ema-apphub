import { Router } from 'express';
import { one, q } from '../db/pool';
import { ah, notFound } from '../lib/http';

/** Avisos del usuario logueado (hoy sólo los superadministradores los reciben). */
const r = Router();

r.get('/notifications', ah(async (req, res) => {
  const uid = req.user!.id;
  const items = await q(
    `SELECT n.id, n.kind, n.severity, n.title, n.body, n.application_id AS "applicationId", n.created_at AS "createdAt", n.read_at AS "readAt"
     FROM notifications n WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`, [uid]);
  const { unread } = (await one<{ unread: number }>(`SELECT count(*)::int AS unread FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [uid]))!;
  res.json({ unread, items });
}));

r.post('/notifications/read-all', ah(async (req, res) => {
  await q(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [req.user!.id]);
  res.json({ ok: true });
}));

r.post('/notifications/:nid/read', ah(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.nid)) throw notFound('Aviso no encontrado');
  const row = await one(`UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.nid, req.user!.id]);
  if (!row) throw notFound('Aviso no encontrado');
  res.json({ ok: true });
}));

export default r;
