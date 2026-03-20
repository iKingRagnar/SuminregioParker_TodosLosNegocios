# Leer SistemaGestion_Demo.xlsm y mostrar datos de catálogos
import openpyxl
import json
wb = openpyxl.load_workbook(r'c:\Users\ragna\Downloads\SistemaGestion_Demo.xlsm', read_only=True, data_only=True)
for name in ['CAT_CLIENTES', 'CAT_REFACCIONES', 'CAT_MAQUINAS']:
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    print('===', name, '===')
    for i, row in enumerate(rows[:25]):
        print(i, row)
    print()
wb.close()
