require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { pool, initSchema } = require("./db");

const app = express();
const server = http.createServer(app);

const ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: "10mb" })); // suficiente para fotos/archivos pequeños en base64

const io = new Server(server, {
  cors: { origin: ORIGIN, methods: ["GET", "POST", "DELETE"] },
});

// Normaliza números: quita espacios, guiones, paréntesis
const cleanPhone = (p) => String(p || "").replace(/[\s\-()]/g, "");
const isValidPhone = (p) => /^\+?\d{7,15}$/.test(p);

// ---------------------------------------------------------------------------
// Salud del servicio (Render lo usa para verificar que el servicio responde)
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.json({ ok: true, service: "nexo-backend" }));
app.get("/health", (_req, res) => res.json({ status: "up" }));

// ---------------------------------------------------------------------------
// Registro / usuarios
// ---------------------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = cleanPhone(req.body.phone);
  if (!name) return res.status(400).json({ error: "Nombre requerido." });
  if (!isValidPhone(phone)) return res.status(400).json({ error: "Número de teléfono inválido." });

  try {
    await pool.query(
      `INSERT INTO users (phone, name) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name`,
      [phone, name]
    );
    res.json({ phone, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar usuario." });
  }
});

app.get("/api/users/:phone", async (req, res) => {
  const phone = cleanPhone(req.params.phone);
  const { rows } = await pool.query("SELECT phone, name FROM users WHERE phone = $1", [phone]);
  if (!rows[0]) return res.status(404).json({ error: "Usuario no encontrado." });
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------------
app.get("/api/contacts/:ownerPhone", async (req, res) => {
  const ownerPhone = cleanPhone(req.params.ownerPhone);
  const { rows } = await pool.query(
    "SELECT id, contact_phone AS phone, contact_name AS name FROM contacts WHERE owner_phone = $1 ORDER BY contact_name",
    [ownerPhone]
  );
  res.json(rows);
});

app.post("/api/contacts", async (req, res) => {
  const ownerPhone = cleanPhone(req.body.ownerPhone);
  const contactPhone = cleanPhone(req.body.contactPhone);
  const contactName = String(req.body.contactName || "").trim();

  if (!isValidPhone(ownerPhone) || !isValidPhone(contactPhone)) {
    return res.status(400).json({ error: "Número de teléfono inválido." });
  }
  if (!contactName) return res.status(400).json({ error: "Nombre requerido." });
  if (ownerPhone === contactPhone) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });

  try {
    const { rows } = await pool.query(
      `INSERT INTO contacts (owner_phone, contact_phone, contact_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_phone, contact_phone) DO UPDATE SET contact_name = EXCLUDED.contact_name
       RETURNING id, contact_phone AS phone, contact_name AS name`,
      [ownerPhone, contactPhone, contactName]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al agregar contacto." });
  }
});

// Elimina el contacto Y todo el historial de mensajes entre ambos números.
// Es un borrado real (DELETE), no un marcador de "oculto" ni "eliminado":
// no queda ninguna fila ni rastro en la base de datos.
app.delete("/api/contacts/:id", async (req, res) => {
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "DELETE FROM contacts WHERE id = $1 RETURNING owner_phone, contact_phone",
      [id]
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Contacto no encontrado." });
    }
    const { owner_phone, contact_phone } = rows[0];
    await client.query(
      `DELETE FROM messages
       WHERE (from_phone = $1 AND to_phone = $2) OR (from_phone = $2 AND to_phone = $1)`,
      [owner_phone, contact_phone]
    );
    await client.query("COMMIT");
    res.json({ deleted: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Error al eliminar contacto." });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Mensajes (historial vía REST; envío en vivo vía Socket.io más abajo)
// ---------------------------------------------------------------------------
app.get("/api/messages/:phoneA/:phoneB", async (req, res) => {
  const a = cleanPhone(req.params.phoneA);
  const b = cleanPhone(req.params.phoneB);
  const { rows } = await pool.query(
    `SELECT id, from_phone, to_phone, type, content, file_name, file_size, created_at
     FROM messages
     WHERE (from_phone = $1 AND to_phone = $2) OR (from_phone = $2 AND to_phone = $1)
     ORDER BY created_at ASC`,
    [a, b]
  );
  res.json(rows);
});

// Borrado real e individual de un mensaje: se elimina la fila, sin dejar rastro.
app.delete("/api/messages/:id", async (req, res) => {
  const { rows } = await pool.query(
    "DELETE FROM messages WHERE id = $1 RETURNING id, from_phone, to_phone",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Mensaje no encontrado." });

  // Avisa en vivo a ambas partes para que lo quiten de su pantalla
  io.to(`phone:${rows[0].from_phone}`).to(`phone:${rows[0].to_phone}`).emit("message:deleted", {
    id: rows[0].id,
  });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Tiempo real: mensajería, presencia y señalización de llamadas (WebRTC)
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  socket.on("identify", (phone) => {
    const clean = cleanPhone(phone);
    if (!isValidPhone(clean)) return;
    socket.data.phone = clean;
    socket.join(`phone:${clean}`);
    io.to(`phone:${clean}`).emit("presence:online");
  });

  // --- Mensajería ---
  socket.on("message:send", async (msg, ack) => {
    const fromPhone = cleanPhone(socket.data.phone);
    const toPhone = cleanPhone(msg.toPhone);
    if (!fromPhone || !isValidPhone(toPhone)) return ack && ack({ error: "Datos inválidos." });

    try {
      const { rows } = await pool.query(
        `INSERT INTO messages (from_phone, to_phone, type, content, file_name, file_size)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, from_phone, to_phone, type, content, file_name, file_size, created_at`,
        [fromPhone, toPhone, msg.type, msg.content, msg.fileName || null, msg.fileSize || null]
      );
      const saved = rows[0];
      io.to(`phone:${toPhone}`).emit("message:new", saved);
      ack && ack({ ok: true, message: saved });
    } catch (err) {
      console.error(err);
      ack && ack({ error: "No se pudo enviar el mensaje." });
    }
  });

  // --- Señalización WebRTC (llamada de voz / video) ---
  socket.on("call:offer", ({ toPhone, offer, type }) => {
    io.to(`phone:${cleanPhone(toPhone)}`).emit("call:offer", { fromPhone: socket.data.phone, offer, type });
  });
  socket.on("call:answer", ({ toPhone, answer }) => {
    io.to(`phone:${cleanPhone(toPhone)}`).emit("call:answer", { fromPhone: socket.data.phone, answer });
  });
  socket.on("call:ice-candidate", ({ toPhone, candidate }) => {
    io.to(`phone:${cleanPhone(toPhone)}`).emit("call:ice-candidate", { fromPhone: socket.data.phone, candidate });
  });
  socket.on("call:end", ({ toPhone }) => {
    io.to(`phone:${cleanPhone(toPhone)}`).emit("call:end", { fromPhone: socket.data.phone });
  });

  socket.on("disconnect", () => {
    if (socket.data.phone) io.to(`phone:${socket.data.phone}`).emit("presence:offline");
  });
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    server.listen(PORT, () => console.log(`Nexo backend escuchando en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error("No se pudo inicializar la base de datos:", err);
    process.exit(1);
  });
