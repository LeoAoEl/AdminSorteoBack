CREATE TABLE `ganadores` (
  `ID_GANADOR` int NOT NULL AUTO_INCREMENT,
  `ID_SORTEO` int NOT NULL,
  `nombre` varchar(255) NOT NULL,
  `celular` varchar(15) NOT NULL,
  `correo` varchar(255) NOT NULL,
  `lugar` varchar(255) NOT NULL,
  `fecha_ganado` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID_GANADOR`),
  KEY `ID_SORTEO` (`ID_SORTEO`),
  CONSTRAINT `ganadores_ibfk_1` FOREIGN KEY (`ID_SORTEO`) REFERENCES `sorteos` (`ID_SORTEO`)
) 