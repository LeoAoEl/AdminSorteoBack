const express = require("express");
require("dotenv").config(); // Importa dotenv al inicio
const mysql = require("mysql2/promise");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());
const cron = require("node-cron");
// 1 minuto
//'0 0 * * *' esto es media noche
cron.schedule("0 0 * * *", () => {
  console.log("Verificando boletos expirados...");
  actualizarBoletosExpirados();
});
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const nodemailer = require("nodemailer");

// Configuración del transportador
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "elnevadosorteos@gmail.com", // Tu correo
    pass: "raif qamg pdkw cjxk", // Contraseña de aplicación
  },
});

// Función para enviar correos
async function enviarCorreo(destinatario, asunto, mensaje) {
  try {
    const info = await transporter.sendMail({
      from: '"Nevado Sorteos" <elnevadosorteos@gmail.com>', // Remitente
      to: destinatario, // Destinatario(s)
      subject: asunto, // Asunto del correo
      html: mensaje, // Contenido en HTML
    });

    console.log("Correo enviado:", info.messageId);
  } catch (error) {
    console.error("Error al enviar correo:", error);
  }
}

//Insertar nuevo sorteo
app.post("/sorteos", async (req, res) => {
  console.log("Entró al endpoint sorteos,", req.body.data);
  const { nombre, isActive, descripcion } = req.body.data;

  if (!nombre) {
    return res
      .status(400)
      .json({ error: "El nombre del sorteo es obligatorio." });
  }

  const connection = await db.getConnection();
  try {
    // Iniciar una transacción
    await connection.beginTransaction();

    // Verificar si existen sorteos
    const [sorteos] = await connection.query(
      "SELECT COUNT(*) as count FROM sorteos"
    );
    const totalSorteos = sorteos[0].count;

    let finalIsActive = isActive; // Determinar el estado final del sorteo

    if (totalSorteos === 0) {
      // Si no hay sorteos, forzar que el nuevo sea activo
      finalIsActive = 1;
    } else if (isActive) {
      // Si se intenta insertar un sorteo activo, verificar que no exista otro activo
      const [activeSorteos] = await connection.query(
        "SELECT COUNT(*) as activeCount FROM sorteos WHERE isActive = 1"
      );
      if (activeSorteos[0].activeCount > 0) {
        return res
          .status(200)
          .json({ error: "Solo puede haber un sorteo activo a la vez." });
      }
    }

    // Insertar el nuevo sorteo
    const [result] = await connection.query(
      "INSERT INTO sorteos (nombre, isActive, descripcion) VALUES (?, ?, ?)",
      [nombre, finalIsActive, descripcion]
    );
    const sorteoId = result.insertId;

    // Crear los 60,000 boletos
    const boletos = Array.from({ length: 60000 }, (_, i) => [
      sorteoId,
      (i + 1).toString().padStart(5, "0"), // Formateo el número con ceros a la izquierda
      "libre",
    ]);
    const placeholders = boletos.map(() => "(?, ?, ?)").join(", ");
    const flatBoletos = boletos.flat();

    await connection.query(
      `INSERT INTO boletos (ID_SORTEO, numero_boleto, estado) VALUES ${placeholders}`,
      flatBoletos
    );

    // Confirmar la transacción
    await connection.commit();

    res.status(201).json({ message: "Sorteo creado con éxito", sorteoId });
  } catch (error) {
    // Revertir cambios en caso de error
    await connection.rollback();
    console.error(error);
    res.status(500).json({ error: "Error al crear el sorteo" });
  } finally {
    connection.release();
  }
});

//Actualizar datos de sorteo
app.put("/sorteos/:id", async (req, res) => {
  const { id } = req.params;
  const { nombre, isActive, descripcion } = req.body.data;

  if (!nombre) {
    return res
      .status(400)
      .json({ error: "El nombre del sorteo es obligatorio." });
  }

  const connection = await db.getConnection();
  try {
    // Comprobar si hay sorteos existentes
    const [sorteos] = await connection.query(
      "SELECT COUNT(*) as count FROM sorteos"
    );
    const totalSorteos = sorteos[0].count;

    // Si no hay sorteos, forzar que este sea activo
    if (totalSorteos === 0) {
      await connection.query(
        "UPDATE sorteos SET nombre = ?, isActive = 1, descripcion = ? WHERE ID_SORTEO = ?",
        [nombre, descripcion, id]
      );
      return res.status(200).json({
        message:
          "Sorteo actualizado y activado automáticamente como el primero",
      });
    }

    // Si el usuario desea activar este sorteo
    if (isActive) {
      // Desactivar todos los sorteos activos, excepto el actual
      await connection.query(
        "UPDATE sorteos SET isActive = 0 WHERE isActive = 1 AND ID_SORTEO != ?",
        [id]
      );
    }

    // Verificar si el sorteo que se está intentando desactivar es el único activo
    if (!isActive) {
      const [activeSorteos] = await connection.query(
        "SELECT COUNT(*) as activeCount FROM sorteos WHERE isActive = 1"
      );
      if (activeSorteos[0].activeCount === 1) {
        // Si hay solo un sorteo activo, no permitir desactivarlo
        return res.status(200).json({
          error: "No se puede desactivar el único sorteo activo.",
        });
      }
    }

    // Actualizar el sorteo
    await connection.query(
      "UPDATE sorteos SET nombre = ?, isActive = ?, descripcion = ? WHERE ID_SORTEO = ?",
      [nombre, isActive, descripcion, id]
    );

    res.status(200).json({ message: "Sorteo actualizado correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar el sorteo" });
  } finally {
    connection.release();
  }
});

//Obtener todos los sorteos
app.get("/sorteos", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM sorteos");
    res.json(rows);
    console.log("entró a get todos los sorteos", rows);
  } catch (error) {
    console.log("error", error);
  }
});
const formatFecha = (fecha) => {
  // Verifica si la fecha es válida antes de formatear
  if (!fecha) return null; // Si la fecha es null o undefined, retorna null

  const options = { day: "numeric", month: "long", year: "numeric" };
  return new Intl.DateTimeFormat("es-ES", options).format(new Date(fecha));
};

//obtener boletos por id de sorteo
app.get("/boletos/:sorteoId", async (req, res) => {
  const { sorteoId } = req.params;

  try {
    const [rows] = await db.query("SELECT * FROM boletos WHERE ID_SORTEO = ?", [
      sorteoId,
    ]);

    // Renombrar el campo ID_BOLETO a id
    const transformedRows = rows.map((boleto) => ({
      id: boleto.ID_BOLETO,
      numero_boleto: boleto.numero_boleto,
      ID_SORTEO: boleto.ID_SORTEO,
      estado: boleto.estado,
      nombre: boleto.nombre,
      celular: boleto.celular,
      correo: boleto.correo,
      fecha_apartado: boleto.fecha_apartado
        ? formatFecha(boleto.fecha_apartado)
        : null,
    }));

    res.json(transformedRows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener los boletos" });
  }
});
//confirmar boletos por 1 o varios seleccionados
app.post("/boletos/confirmar", async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "No se enviaron IDs válidos" });
  }

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const query = `UPDATE boletos SET estado = 'confirmado' WHERE ID_BOLETO IN (${placeholders})`;
    const [result] = await db.query(query, ids);

    // Enviar correo de confirmación

    // Recuperar los números de los boletos desde la base de datos
    const query2 = `
        SELECT numero_boleto, correo 
        FROM boletos 
        WHERE ID_BOLETO IN (?)
      `;

    const [result2] = await db.query(query2, [ids]);

    const numerosBoletos = result2.map((boleto) => boleto.numero_boleto);
    const correo = result2[0].correo; // Toma el correo del primer boleto

    // Enviar correo de confirmación
    const asunto = "Confirmación de Boletos";
    const mensaje = `
      <h1>¡Hola, ${nombre}!</h1>
      <p> los siguientes boletos fueron confirmados:</p>
      <ul>
        ${numerosBoletos.map((num) => `<li>Boleto Nº: ${num}</li>`).join("")}
      </ul>
      <p>Gracias por elegir Nevado Sorteos.</p>
    `;
    await enviarCorreo(correo, asunto, mensaje);

    res.json({
      message: `${result.affectedRows} boleto(s) actualizado(s) a "confirmado".`,
    });
  } catch (error) {
    console.error("Error al actualizar boletos:", error);
    res.status(500).json({ error: "Error al confirmar boletos" });
  }
});

app.post("/boletos/desconfirmar", async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "No se enviaron IDs válidos" });
  }

  try {
    // Actualizar los boletos a estado "libre"
    const placeholders = ids.map(() => "?").join(", ");
    const query = `UPDATE boletos SET estado = 'apartado' WHERE ID_BOLETO IN (${placeholders})`;
    const [result] = await db.query(query, ids);

    // Recuperar los números de los boletos desde la base de datos
    const query2 = `
        SELECT numero_boleto, correo 
        FROM boletos 
        WHERE ID_BOLETO IN (?)
      `;
    const [result2] = await db.query(query2, [ids]);

    if (result2.length === 0) {
      return res
        .status(404)
        .json({ error: "No se encontraron boletos para desconfirmar." });
    }

    const numerosBoletos = result2.map((boleto) => boleto.numero_boleto);
    const correo = result2[0].correo; // Tomar el correo del primer boleto

    // Enviar correo de desconfirmación
    const asunto = "Desconfirmación de Boletos";
    const mensaje = `
      <h1>¡Hola!</h1>
      <p>Los siguientes boletos han sido desconfirmados:</p>
      <ul>
        ${numerosBoletos.map((num) => `<li>Boleto Nº: ${num}</li>`).join("")}
      </ul>
      <p>Gracias por elegir Nevado Sorteos.</p>
    `;
    await enviarCorreo(correo, asunto, mensaje);

    res.json({
      message: `${result.affectedRows} boleto(s) actualizado(s) a "libre".`,
    });
  } catch (error) {
    console.error("Error al desconfirmar boletos:", error);
    res.status(500).json({ error: "Error al desconfirmar boletos" });
  }
});

app.get("/boletos/correo/:correo", async (req, res) => {
  const { correo } = req.params;

  try {
    const [rows] = await db.query("SELECT * FROM boletos WHERE correo = ?", [
      correo,
    ]);

    // Renombrar el campo ID_BOLETO a id
    const transformedRows = rows.map((boleto) => ({
      id: boleto.ID_BOLETO,
      numero_boleto: boleto.numero_boleto,
      ID_SORTEO: boleto.ID_SORTEO,
      estado: boleto.estado,
      nombre: boleto.nombre,
      //celular: boleto.celular,
      correo: boleto.correo,
      fecha_apartado: boleto.fecha_apartado
        ? formatFecha(boleto.fecha_apartado)
        : null,
    }));

    res.json(transformedRows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener los boletos por correo" });
  }
});

// Guardar ganador con lugar
app.post("/ganadores", async (req, res) => {
  const { ID_SORTEO, nombre, celular, correo, lugar } = req.body.data;
  console.log("body ganadores", req.body.data);

  if (!ID_SORTEO || !nombre || !celular || !correo || !lugar) {
    return res
      .status(400)
      .json({ message: "Todos los campos son obligatorios." });
  }

  try {
    // Verificar si el sorteo existe y está activo
    const [sorteo] = await db.execute(
      "SELECT * FROM sorteos WHERE ID_SORTEO = ?",
      [ID_SORTEO]
    );

    if (sorteo.length === 0) {
      return res
        .status(404)
        .json({ message: "Sorteo no encontrado o no está activo." });
    }

    // Agregar el ganador con el lugar
    await db.execute(
      "INSERT INTO ganadores (ID_SORTEO, nombre, celular, correo, lugar) VALUES (?, ?, ?, ?, ?)",
      [ID_SORTEO, nombre, celular, correo, lugar]
    );

    res.status(201).json({ message: "Ganador agregado exitosamente." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error al agregar el ganador." });
  }
});

// Obtener ganadores con orden por lugar y por sorteo
app.get("/ganadores", async (req, res) => {
  const { ID_SORTEO } = req.query;

  if (!ID_SORTEO) {
    return res.status(400).json({ error: "ID_SORTEO es obligatorio." });
  }

  const query = `
    SELECT g.ID_GANADOR, g.nombre, g.celular, g.correo, g.lugar, s.nombre AS sorteo
    FROM ganadores g
    JOIN sorteos s ON g.ID_SORTEO = s.ID_SORTEO
    WHERE g.ID_SORTEO = ?
    ORDER BY g.lugar ASC
  `;

  try {
    const [results] = await db.query(query, [ID_SORTEO]);
    res.json(results);
  } catch (err) {
    console.error("Error al obtener ganadores:", err);
    res.status(500).json({ error: "Error al obtener ganadores" });
  }
});
app.delete("/ganadores/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Eliminar el ganador por su ID
    const [result] = await db.execute(
      "DELETE FROM ganadores WHERE ID_GANADOR = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Ganador no encontrado." });
    }

    res.status(200).json({ message: "Ganador eliminado exitosamente." });
  } catch (error) {
    console.error("Error al eliminar ganador:", error);
    res.status(500).json({ message: "Error al eliminar el ganador." });
  }
});
//todos los ganadores historico de todos los sorteos
app.get("/ganadores/todos", async (req, res) => {
  const query = `
    SELECT g.ID_GANADOR, g.nombre, g.celular, g.correo, g.lugar, s.nombre AS sorteo
    FROM ganadores g
    JOIN sorteos s ON g.ID_SORTEO = s.ID_SORTEO
    ORDER BY s.nombre ASC, g.lugar ASC
  `;

  try {
    const [results] = await db.query(query); // Usar promesas con .query()
    res.json(results);
  } catch (err) {
    console.error("Error al obtener todos los ganadores:", err);
    res.status(500).json({ error: "Error al obtener todos los ganadores" });
  }
});

app.get("/sorteos/activo", async (req, res) => {
  const connection = await db.getConnection();
  try {
    // Obtener el sorteo activo
    const [sorteo] = await connection.query(
      "SELECT * FROM sorteos WHERE isActive = 1 LIMIT 1"
    );

    // Si no hay un sorteo activo, devolver un error
    if (sorteo.length === 0) {
      return res.status(404).json({ error: "No hay sorteos activos." });
    }

    // Obtener los 60,000 boletos asociados al sorteo activo
    const [boletos] = await connection.query(
      "SELECT * FROM boletos WHERE ID_SORTEO = ? LIMIT 60000",
      [sorteo[0].ID_SORTEO]
    );

    // Devolver el sorteo activo con sus boletos
    res.json({
      sorteo: sorteo[0],
      boletos: boletos,
    });
    console.log("Sorteo activo con boletos:", sorteo[0]);
  } catch (error) {
    console.log("Error al obtener el sorteo activo o los boletos:", error);
    res.status(500).json({ error: "Error al obtener el sorteo activo." });
  } finally {
    connection.release();
  }
});
//Apartar boletos con su id :
// Apartar boletos (cambiar estado a 'apartado' y guardar información)
/* body esperado al apartar boletos
{
  "ids": [1, 2, 3],  // IDs de los boletos a apartar
  "nombre": "Juan Pérez",
  "celular": "555-1234",
  "correo": "juan@example.com"
} */
app.put("/boletos/apartar", async (req, res) => {
  const { ids, nombre, celular, correo } = req.body;

  // Validar que se reciban los campos necesarios
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res
      .status(400)
      .json({ error: "Debe enviar al menos un ID de boleto." });
  }
  if (!nombre || !celular || !correo) {
    return res
      .status(400)
      .json({ error: "El nombre, celular y correo son obligatorios." });
  }

  const connection = await db.getConnection();
  try {
    // Obtener la fecha actual
    const fecha_apartado = new Date();

    // Iniciar una transacción para asegurar que todos los boletos se actualicen correctamente
    await connection.beginTransaction();

    // Actualizar el estado de los boletos a 'apartado' y guardar la información del usuario
    const [result] = await connection.query(
      `UPDATE boletos
       SET estado = 'apartado', nombre = ?, celular = ?, correo = ?, fecha_apartado = ?
       WHERE ID_BOLETO IN (?) AND estado = 'libre'`,
      [nombre, celular, correo, fecha_apartado, ids]
    );

    // Si no se actualizaron boletos, devolver un mensaje de error
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: "No se encontraron boletos libres para apartar." });
    }

    // Confirmar la transacción
    await connection.commit();
    // Enviar correo de confirmación

    // Recuperar los números de los boletos desde la base de datos
    const query = "SELECT numero_boleto FROM boletos WHERE ID_BOLETO IN (?)";
    const [result2] = await db.query(query, [ids]);

    const numerosBoletos = result2.map((boleto) => boleto.numero_boleto);

    // Enviar correo de confirmación
    const asunto = "Confirmación de Apartado de Boletos";
    const mensaje = `
      <h1>¡Hola, ${nombre}!</h1>
      <p>Hemos recibido tu solicitud para apartar los siguientes boletos:</p>
      <ul>
        ${numerosBoletos.map((num) => `<li>Boleto Nº: ${num}</li>`).join("")}
      </ul>
      <p>Nos pondremos en contacto contigo al número ${celular} para más detalles.</p>
      <p>Gracias por elegir Nevado Sorteos.</p>
    `;
    await enviarCorreo(correo, asunto, mensaje);

    // Responder con éxito
    res.status(200).json({
      message: `${result.affectedRows} boleto(s) apartado(s) con éxito.`,
    });
  } catch (error) {
    // En caso de error, deshacer la transacción
    await connection.rollback();
    console.log("Error al apartar boletos:", error);
    res.status(500).json({ error: "Error al apartar los boletos." });
  } finally {
    connection.release();
  }
});

//creo que es no se usa
app.put("/boletos/:id/estado", async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;

  try {
    await db.query("UPDATE boletos SET estado = ? WHERE ID_BOLETO = ?", [
      estado,
      id,
    ]);
    res.status(200).json({ message: "Estado actualizado correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar el estado" });
  }
});

// Función para actualizar los boletos cuyo apartado haya expirado
async function actualizarBoletosExpirados() {
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - 3); // Fecha actual menos 3 días

  const query = `
    UPDATE boletos
    SET estado = 'libre'
    WHERE estado = 'apartado'
    AND fecha_apartado <= ?
  `;

  db.query(query, [fechaLimite], (err, results) => {
    if (err) {
      console.error("Error actualizando boletos expirados:", err);
      return;
    }
    console.log(
      `${results.affectedRows} boletos han sido actualizados a "libre".`
    );
  });
}

app.listen(5000, () =>
  console.log("Servidor corriendo en http://localhost:5000")
);
