CREATE DATABASE document_history;

USE document_history;

CREATE TABLE versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id VARCHAR(255) NOT NULL,
    version_file_id VARCHAR(255) NOT NULL,
    editor VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
