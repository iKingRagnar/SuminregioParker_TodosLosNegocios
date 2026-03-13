# Referencia: tablas Microsip (CUENTAS CONTABLES_FUENTES.xlsx)

Documento generado a partir del Excel **CUENTAS CONTABLES_FUENTES.xlsx** para alinear el API y los dashboards con la estructura real de Microsip.

---

## Hoja FUENTES – Tablas por módulo

### Por Cobrar (CxC)
| Tabla | Descripción | Tipo |
|-------|-------------|------|
| **DOCTOS_CC** | Cuentas por Cobrar, CXC | Mov |
| **IMPORTES_DOCTOS_CC** | Cuentas por Cobrar Detalle | Detalle |
| **IMPORTES_DOCTOS_CC_IMPTOS** | Cuentas por Cobrar Impuestos | Impuestos |
| **CONDICIONES_PAGO** | Condición CXC (días de crédito, etc.) | Maestro |
| **CONCEPTOS_CC** | Conceptos de CXC | Maestro |
| **DEPOSITOS_CC** | Depósitos de CxC | — |
| **DEPOSITOS_CC_DET** | Liga DOCTOS_CC con DEPOSITOS_CC | — |
| **ANTICIPOS_CC** | Anticipos Clientes | Mov |
| **FORMAS_COBRO_CC** | Formas de Cobro de CXC | Maestro |
| **FORMAS_COBRO_DOCTOS** | Formas de cobro en los documentos | — |
| **DOCTOS_PEND_CC** | ¿? no trae info | — |
| **DOCTOS_RP** / **DOCTOS_RP_DET** | CFDI recepción de pago (varios cobros) | Mov/Detalle |

### Ventas
| Tabla | Descripción | Tipo |
|-------|-------------|------|
| **DOCTOS_VE** | Ventas | Mov |
| **DOCTOS_VE_DET** | Ventas Detalle | Detalle |
| **DOCTOS_VE_LIGAS** | “Aplica” (aplicaciones) | — |
| **DOCTOS_VE_LIGAS_DET** | “AplicaID” | — |
| **DESGLOSE_EN_DISCRETOS_VE** | Series en movimientos de Ventas | — |
| **FOLIOS_VENTAS** | Consecutivos | Config |
| **IMPUESTOS_DOCTOS_VE** / **IMPUESTOS_DOCTOS_VE_DET** | Impuestos ventas | — |

### Punto de Venta (PV / Mostrador)
| Tabla | Descripción | Tipo |
|-------|-------------|------|
| **DOCTOS_PV** | Punto de Venta | Mov |
| **DOCTOS_PV_DET** | Punto de Venta Detalle | Detalle |
| **DOCTOS_PV_COBROS** | Cobros PV | — |
| **DOCTOS_PV_LIGAS** / **DOCTOS_PV_LIGAS_DET** | Aplicaciones | — |
| **IMPUESTOS_DOCTOS_PV** / **IMPUESTOS_DOCTOS_PV_DET** | Impuestos PV | — |

### Clientes
| Tabla | Descripción | Tipo |
|-------|-------------|------|
| **CLIENTES** | Catálogo clientes | Catalogo |
| **DIRS_CLIENTES** | Sucursales y direcciones | Catalogo |
| **CLAVES_CLIENTES** | Claves | Claves |
| **FORMAS_COBRO_CLIENTES** | Relación formas de cobro con clientes | Lateral |
| **ARTICULOS_CLIENTES** | — | — |
| **CONTACTOS_CLIENTES** | Nueva! | — |

### Contabilidad (para P&amp;L / Resultados)
| Tabla | Descripción | Tipo |
|-------|-------------|------|
| **DOCTOS_CO** | Contabilidad (pólizas) | Mov |
| **DOCTOS_CO_DET** | Contabilidad Detalle | Detalle |
| **CUENTAS_CO** | Cuentas contables | Catalogo |
| **GRUPOS_CUENTAS** | Cuentas de título | Config |
| **GRUPOS_CUENTAS_DET** | Cuentas de título detalle | Config |
| **DEPTOS_CO** | Centros de costo (referencia en Consultas_Contabilidad) | — |

### Inventarios
| Tabla | Descripción | Tipo |
|-------|-------------|------|
| **DOCTOS_IN** | Inventarios | Mov |
| **DOCTOS_IN_DET** | Inventarios Detalle | Detalle |
| **ALMACENES** | Catálogo | Catalogo |
| **ARTICULOS** | Catálogo | Catalogo |

### Otros maestros útiles
| Tabla | Descripción |
|-------|-------------|
| **VENDEDORES** | (no listada en FUENTES; típica en Microsip para ventas) |
| **CONDICIONES_PAGO** | Días de crédito (DIAS_PPAG) para CxC |

---

## Hoja Consultas_Contabilidad

- Conexión ODBC: **dsn=Suminregio.ddns.net** (Power Query).
- Tablas referenciadas en las consultas:
  - **DEPTOS_CO** (centros de costo).
  - **CUENTAS_CO**, **CUENTAS_CO_DIOT**, **CUENTAS_NO**, **GRUPOS_CUENTAS**, **GRUPOS_CUENTAS_DET**.
  - **DOCTOS_CO**, **DOCTOS_CONSOLIDADOS**, **DOCTOS_CO_CFDI**, **DOCTOS_CO_DET**, **DOCTOS_CO_DET_CFDI**, **DOCTOS_CO_DET_DIOT**, **DOCTOS_CO_DET_INFO_BAN**.

Sirve para alinear el módulo de **Resultados (P&amp;L)** y cualquier reporte que use pólizas contables (DOCTOS_CO / DOCTOS_CO_DET) y catálogo de cuentas (CUENTAS_CO).

---

## Uso en el API (server_corregido.js)

- **CxC (vencido / vigente):**  
  Usar **DOCTOS_CC** + **IMPORTES_DOCTOS_CC** (y si aplica vencimientos, la tabla de vencimientos que use tu versión).  
  Fecha de vencimiento: de **CONDICIONES_PAGO.DIAS_PPAG** + fecha del documento, o tabla de vencimientos si existe.

- **Ventas (resumen, por vendedor, cumplimiento):**  
  **DOCTOS_VE** (+ **DOCTOS_VE_DET** para importes/líneas).  
  **DOCTOS_PV** para canal mostrador.

- **Clientes (riesgo, inactivos):**  
  **CLIENTES** + saldos/doctos desde **DOCTOS_CC** / **IMPORTES_DOCTOS_CC**.

- **Resultados / P&amp;L:**  
  Ventas desde **DOCTOS_VE** / **DOCTOS_PV**; costos desde **DOCTOS_VE_DET** (si tienes costo ahí) o desde **DOCTOS_CO** / **DOCTOS_CO_DET** y **CUENTAS_CO** si lo calculas por contabilidad.

---

## Ventas.pbix

El archivo **Ventas.pbix** es binario y no se puede leer desde este entorno. Para aprovecharlo:

1. Abrirlo en **Power BI Desktop**.
2. Revisar en el panel **Modelo** qué tablas y columnas usa (sobre todo de Ventas, CxC, Clientes).
3. En **Transformar datos** (Power Query) ver las consultas M y los nombres de tablas/columnas.
4. Si necesitas compartir estructura con el API: exportar lista de **medidas** y **columnas clave** (por ejemplo en un Excel o en este mismo documento) y referenciarlas en `LOGICA_CXC_Y_FILTROS.md` y en el código del servidor.

Con eso se puede alinear la lógica de ventas, CxC y resultados con lo que ya tienes en **CUENTAS CONTABLES_FUENTES.xlsx** y en el dashboard.
