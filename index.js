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

    res.json({
      message: `${result.affectedRows} boleto(s) actualizado(s) a "confirmado".`,
    });
  } catch (error) {
    console.error("Error al actualizar boletos:", error);
    res.status(500).json({ error: "Error al confirmar boletos" });
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

//endpoints para pagina
// Obtener el sorteo activo con sus 60,000 boletos
//Reponse:
/* {
  "sorteo": {
    "ID_SORTEO": 1,
    "nombre": "Sorteo #1",
    "isActive": 1,
    "descripcion": "desde 49 varos",
    "fecha_creacion": "2025-01-03T21:34:20.000Z"
  },
  "boletos": [
    {
      "ID_BOLETO": 1,
      "ID_SORTEO": 1,
      "numero_boleto": "00001",
      "estado": "apartado",
      "nombre": "Marcos Avalos",
      "celular": "31218923530",
      "correo": "mavalos8@ucol.mx",
      "fecha_apartado": "2025-01-03T22:42:33.000Z"
    },
    {
      "ID_BOLETO": 2,
      "ID_SORTEO": 1,
      "numero_boleto": "00002",
      "estado": "libre",
      "nombre": null,
      "celular": null,
      "correo": null,
      "fecha_apartado": null
    }]
}
     */
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
/* host: "localhost",
user: "root",
password: "root",
port: "3306",
database: "prestamosdb", */
//1.-Método para conectar el login
app.post("/connect", (req, res) => {
  const { host, user, password, database, port } = req.body;

  const connection = mysql.createConnection({
    host,
    user,
    password,
    port,
    database,
  });

  connection.connect((err) => {
    if (err) {
      return res.status(500).json({
        error: "Error al conectar a la base de datos",
        details: err.message,
      });
    }
    res.json({ message: "Conexión exitosa" });
    connection.end();
  });
});
//2.-Método para traerme todas las tablas de la db actual
app.post("/tables", (req, res) => {
  const { host, user, password, database, port } = req.body;
  const connection = mysql.createConnection({
    host,
    user,
    password,
    database,
    port,
  });

  connection.query("SHOW TABLES", (err, results) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "Error al listar tablas", details: err.message });
    }
    const tables = results.map((row) => Object.values(row)[0]);
    res.json(tables);
    connection.end();
  });
});

/* // Endpoint para obtener datos de la tabla seleccionada
app.post("/getTableData", (req, res) => {
  const { tableName, host, user, password, database, port } = req.body;

  const connection = mysql.createConnection({
    host,
    user,
    password,
    database,
    port,
  });

  // Consulta para obtener datos de la tabla
  const query = `SELECT * FROM ${tableName}`;

  connection.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Error fetching data" });
    }
    res.json(results);
  });
});

app.post("/getTableStructure", (req, res) => {
  const { tableName, host, user, password, database, port } = req.body;

  const connection = mysql.createConnection({
    host,
    user,
    password,
    database,
    port,
  });
  const query = `DESCRIBE ${tableName}`; // Consulta para obtener la estructura de la tabla

  connection.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({
        error: "Error obteniendo la estructura de la tabla",
        details: err.message,
      });
    }
    res.json({ structure: results });
  });
});

app.post("/insertData", (req, res) => {
  const { tableName, host, user, password, database, port, data } = req.body;

  const connection = mysql.createConnection({
    host,
    user,
    password,
    database,
    port,
  });

  // Generar la consulta dinámica de inserción
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data)
    .map((value) => `'${value}'`)
    .join(", ");

  const query = `INSERT INTO ${tableName} (${columns}) VALUES (${values})`;

  connection.query(query, (err, result) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "Error insertando el registro", details: err.message });
    }
    res.json({ message: "Registro insertado correctamente" });
  });
});

//6.-método que elimina los datos dinamicamente
app.post("/deleteRows", async (req, res) => {
  const { table, host, user, password, database, port, queries } = req.body;

  const connection = mysql.createConnection({
    host,
    user,
    password,
    database,
    port,
  });

  if (!table || !queries || queries.length === 0) {
    return res.status(400).json({ error: "Datos inválidos." });
  }

  try {
    // Asume que tienes una conexión a tu base de datos
    for (const query of queries) {
      connection.execute(query); // Ejecuta cada consulta
    }

    res.status(200).json({ message: "Filas eliminadas exitosamente." });
  } catch (error) {
    console.error("Error al eliminar filas:", error);
    res.status(500).json({ error: "Error al eliminar filas." });
  }
});

app.post("/updateData", (req, res) => {
  const { tableName, data, keyFields, originalKeyValues, ...dbConfig } =
    req.body;

  const setClauses = Object.keys(data)
    .map((field) => `\`${field}\` = ?`)
    .join(", ");

  const whereClauses = keyFields.map((key) => `\`${key}\` = ?`).join(" AND ");

  const sql = `UPDATE \`${tableName}\` SET ${setClauses} WHERE ${whereClauses}`;
  const values = [
    ...Object.values(data),
    ...keyFields.map((key) => originalKeyValues[key]),
  ];
  console.log("query update", sql);

  const connection = mysql.createConnection(dbConfig);
  connection.query(sql, values, (error, results) => {
    if (error) {
      return res.status(500).send("Error actualizando los datos");
    }
    res.send("Registro actualizado correctamente");
  });
  connection.end();
});
// Validar consultas de tipo SELECT
const isValidSelectQuery = (query) => {
  const selectRegex = /^\s*SELECT\s.+\sFROM\s.+/i;
  return selectRegex.test(query.trim());
};

// Validar comandos de acción (INSERT, UPDATE, DELETE)
const isValidActionCommand = (query) => {
  const actionRegex = /^\s*(INSERT|UPDATE|DELETE)\s.+/i;
  return actionRegex.test(query.trim());
};
// Endpoint para consultas personalizadas (SELECT)
app.post("/executeQuery", async (req, res) => {
  const { query, ...dbConfig } = req.body;

  if (!isValidSelectQuery(query)) {
    return res.status(400).json({ error: "Consulta SQL no válida" });
  }

  try {
    // Crear conexión y usar Promesas
    const connection = mysql.createConnection(dbConfig).promise();

    // Ejecutar consulta
    const [rows] = await connection.query(query);

    // Cerrar conexión
    await connection.end();

    res.status(200).json({ data: rows });
  } catch (error) {
    console.error("Error ejecutando consulta SELECT:", error);
    res.status(500).json({ error: error.sqlMessage });
  }
});
app.post("/executeAction", async (req, res) => {
  const { query, ...dbConfig } = req.body;

  // Validar que el comando sea seguro (solo INSERT, UPDATE, DELETE)
  if (!isValidActionCommand2(query)) {
    return res
      .status(400)
      .json({ error: "Comando SQL no válido (solo INSERT, UPDATE, DELETE)." });
  }

  try {
    const connection = await mysql.createConnection(dbConfig).promise();

    // Asegúrate de usar parámetros para evitar inyección
    const [result] = await connection.execute(query); // Asegúrate de usar el método execute de mysql2
    await connection.end();

    res.status(200).json({
      message: "Comando ejecutado exitosamente.",
      affectedRows: result.affectedRows,
    });
  } catch (error) {
    console.error("Error ejecutando comando de acción:", error);
    res.status(500).json({ error: error.sqlMessage });
  }
});
// Función de validación de comandos SQL
function isValidActionCommand2(query) {
  const allowedCommands = ["INSERT", "UPDATE", "DELETE"];
  const command = query.trim().split(" ")[0].toUpperCase();
  return allowedCommands.includes(command);
} */
app.listen(5000, () =>
  console.log("Servidor corriendo en http://localhost:5000")
);
