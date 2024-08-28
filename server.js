const express = require('express');
const { google } = require('googleapis');
const mysql = require('mysql');
const bodyParser = require('body-parser');
require('dotenv').config();
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

// Conexión a la base de datos
const db = mysql.createConnection({
    host: process.env.HOST,
    user: process.env.USER,
    password: process.env.PASSWORD_DB,
    database: process.env.DATABASE
});

db.connect(err => {
    if (err) throw err;
    console.log('Conectado a la base de datos MariaDB');
});

drive.files.list({
    pageSize: 1,
    fields: 'files(id, name)',
}, (err, res) => {
    if (err) {
        console.error('Error al conectar con la API de Google Drive:', err);
    } else {
        console.log('Conexión exitosa a la API de Google Drive. Primer archivo encontrado:', res.data.files[0]);
    }
});

// Ruta para obtener el historial de versiones
app.get('/api/versions/:documentId', (req, res) => {
    const documentId = req.params.documentId;
    const sql = `SELECT * FROM versions WHERE document_id = ? ORDER BY created_at DESC`;

    db.query(sql, [documentId], (err, results) => {
        if (err) throw err;
        res.json(results);
    });
});

// Ruta para crear una nueva copia temporal para edición
app.post('/api/editDocument', async (req, res) => {
    const { documentId } = req.body;

    // Verificar si ya existe un archivo temporal para este documento
    const sqlCheck = `SELECT version_file_id FROM versions WHERE document_id = ? AND editor = 'TEMP' ORDER BY created_at DESC LIMIT 1`;

    db.query(sqlCheck, [documentId], async (err, results) => {
        if (err) return res.status(500).json({ message: 'Error checking for existing temp file', error: err });

        if (results.length > 0) {
            // Si ya existe una copia temporal, usarla en lugar de crear una nueva
            const tempFileId = results[0].version_file_id;
            return res.json({ tempFileId, message: 'Existing temporary copy found' });
        }

        try {
            const originalFile = await drive.files.get({ fileId: documentId, fields: 'name' });
            const copyResponse = await drive.files.copy({
                fileId: documentId,
                requestBody: {
                    name: `${originalFile.data.name} (Temporary Edit) - ${new Date().toISOString()}`
                }
            });

            // Devolver la ID de la copia temporal sin insertar en la base de datos
            res.json({ tempFileId: copyResponse.data.id, message: 'Temporary copy created for editing' });
        } catch (error) {
            res.status(500).json({ message: 'Error creating temporary copy', error });
        }
    });
});

// Ruta para guardar la copia como una nueva versión
app.post('/api/saveVersion', async (req, res) => {
    const { tempFileId, documentId, editor } = req.body;

    try {
        const tempFile = await drive.files.get({ fileId: tempFileId, fields: 'name' });

        // Obtener la fecha actual en formato deseado (por ejemplo, YYYY-MM-DD)
        const currentDate = new Date().toISOString();

        // Renombrar el archivo final para eliminar la etiqueta '(Temporary Edit)' y agregar la fecha
        const finalName = tempFile.data.name.replace(/\(Temporary Edit\) - .*/, '').trim();

        // Cambiar el nombre o mover el archivo si es necesario, incluyendo la fecha de edición
        await drive.files.update({
            fileId: tempFileId,
            requestBody: {
                name: `${finalName} - Final Version (${currentDate})`
            }
        });

        // Guardar en el historial de versiones
        const sql = `INSERT INTO versions (document_id, version_file_id, editor, created_at) VALUES (?, ?, ?, NOW())`;
        db.query(sql, [documentId, tempFileId, editor], (err, result) => {
            if (err) throw err;
            res.json({ message: 'Version saved', versionId: result.insertId });
        });
    } catch (error) {
        res.status(500).json({ message: 'Error saving version', error });
    }
});

// Ruta para eliminar la copia temporal si no se guarda
app.post('/api/discardChanges', async (req, res) => {
    const { tempFileId } = req.body;

    try {
        await drive.files.delete({ fileId: tempFileId });
        res.json({ message: 'Temporary copy deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting temporary copy', error });
    }
});

// Ruta para eliminar todas las copias temporales en Google Drive
app.post('/api/cleanupTemporaryFiles', async (req, res) => {
    try {
        // Buscar todos los archivos que tienen el nombre temporal
        const response = await drive.files.list({
            q: "name contains '(Temporary Edit)'",
            fields: 'files(id, name)'
        });

        const files = response.data.files;

        if (files.length === 0) {
            return res.json({ message: 'No temporary files found to delete.' });
        }

        // Eliminar cada archivo temporal
        for (const file of files) {
            await drive.files.delete({ fileId: file.id });
        }

        res.json({ message: `Deleted ${files.length} temporary file(s).` });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting temporary files', error });
    }
});

// Ruta para obtener la URL del archivo para embeber
app.get('/api/getFileUrl/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const file = await drive.files.get({
        fileId,
        fields: 'webViewLink'
    });
    res.json({ url: file.data.webViewLink });
});

// Servir el frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => console.log(`Server running on port ${port}`));
