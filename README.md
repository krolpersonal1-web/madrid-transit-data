# Datos de horarios para un mapa de transporte de Madrid

Este repositorio genera automáticamente, varias veces al día, un archivo compacto (`timetable.json`, rama `data`)
con los horarios de Cercanías Madrid a partir del GTFS oficial de Renfe.

- Fuente: Renfe, datos abiertos (data.renfe.com), licencia CC BY 4.0. Horarios: Renfe.
- `build.mjs` descarga el GTFS y lo compacta (sin dependencias, Node 20+).
- Proyecto personal, sin relación con Renfe.
