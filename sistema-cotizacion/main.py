# -*- coding: utf-8 -*-
"""
Sistema de Cotización y Gestión para Servicio Técnico
Aplicación de escritorio - Python + SQLite (100% gratuito)
"""
import tkinter as tk
from tkinter import ttk, messagebox, filedialog, scrolledtext
import os
from datetime import datetime, timedelta

from database import get_connection, init_db, generar_folio, DB_PATH
from config import IVA_PORCENTAJE, EMPRESA_NOMBRE
from widgets import AutocompleteEntry
from busquedas import buscar_clientes, buscar_refacciones, buscar_maquinas, buscar_tecnicos
from exportar import exportar_cotizacion_excel, exportar_cotizacion_pdf, exportar_mantenimientos_excel


def _fecha_hoy():
    return datetime.now().strftime("%Y-%m-%d")


class App:
    def __init__(self):
        init_db()
        self.root = tk.Tk()
        self.root.title("Sistema de Cotización - Servicio Técnico")
        self.root.minsize(900, 600)
        self.root.geometry("1100x700")

        self._cliente_actual = None
        self._maquina_actual = None

        self._construir_menu()
        self._construir_notebook()

        # Insertar técnicos por defecto si no hay
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM tecnicos")
        if cur.fetchone()[0] == 0:
            for n in ["Juan Pérez", "María García", "Carlos López"]:
                try:
                    cur.execute("INSERT INTO tecnicos (nombre) VALUES (?)", (n,))
                except Exception:
                    pass
        conn.commit()
        conn.close()

    def _construir_menu(self):
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)
        archivo = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="Archivo", menu=archivo)
        archivo.add_command(label="Salir", command=self.root.quit)

    def _construir_notebook(self):
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self._tab_catalogos()
        self._tab_cotizacion_refacciones()
        self._tab_cotizacion_mano_obra()
        self._tab_incidentes()
        self._tab_bitacoras()
        self._tab_mantenimientos()
        self._tab_historial()

    def _tab_catalogos(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Catálogos")

        # Clientes
        lf_clientes = ttk.LabelFrame(frame, text="Clientes", padding=5)
        lf_clientes.pack(fill=tk.X, pady=5)
        ttk.Button(lf_clientes, text="+ Nuevo cliente", command=self._nuevo_cliente).pack(side=tk.LEFT, padx=2)
        cols = ("id", "codigo", "nombre", "rfc", "direccion")
        self.tree_clientes = ttk.Treeview(lf_clientes, columns=cols, show="headings", height=6)
        for c in cols:
            self.tree_clientes.heading(c, text=c.capitalize())
            self.tree_clientes.column(c, width=80 if c == "id" else 150)
        self.tree_clientes.pack(fill=tk.BOTH, expand=True)
        ttk.Button(lf_clientes, text="Editar", command=self._editar_cliente).pack(side=tk.LEFT, padx=2)
        self._cargar_clientes()

        # Refacciones
        lf_ref = ttk.LabelFrame(frame, text="Refacciones", padding=5)
        lf_ref.pack(fill=tk.X, pady=5)
        ttk.Button(lf_ref, text="+ Nueva refacción", command=self._nueva_refaccion).pack(side=tk.LEFT, padx=2)
        cols_r = ("id", "codigo", "descripcion", "precio_unitario")
        self.tree_refacciones = ttk.Treeview(lf_ref, columns=cols_r, show="headings", height=5)
        for c in cols_r:
            self.tree_refacciones.heading(c, text=c.replace("_", " ").title())
            self.tree_refacciones.column(c, width=80 if c == "id" else 120)
        self.tree_refacciones.pack(fill=tk.BOTH, expand=True)
        ttk.Button(lf_ref, text="Editar", command=self._editar_refaccion).pack(side=tk.LEFT, padx=2)
        self._cargar_refacciones()

        # Máquinas (por cliente)
        lf_maq = ttk.LabelFrame(frame, text="Máquinas (por cliente)", padding=5)
        lf_maq.pack(fill=tk.X, pady=5)
        ttk.Button(lf_maq, text="+ Nueva máquina", command=self._nueva_maquina).pack(side=tk.LEFT, padx=2)
        cols_m = ("id", "codigo", "nombre", "cliente_id")
        self.tree_maquinas = ttk.Treeview(lf_maq, columns=cols_m, show="headings", height=4)
        for c in cols_m:
            self.tree_maquinas.heading(c, text=c.replace("_", " ").title())
            self.tree_maquinas.column(c, width=80)
        self.tree_maquinas.pack(fill=tk.BOTH, expand=True)
        ttk.Button(lf_maq, text="Editar", command=self._editar_maquina).pack(side=tk.LEFT, padx=2)
        self._cargar_maquinas()

    def _cargar_clientes(self):
        for i in self.tree_clientes.get_children():
            self.tree_clientes.delete(i)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT id, codigo, nombre, rfc, direccion FROM clientes ORDER BY nombre")
        for r in cur.fetchall():
            self.tree_clientes.insert("", tk.END, values=(r["id"], r["codigo"] or "", r["nombre"], r["rfc"] or "", (r["direccion"] or "")[:30]))
        conn.close()

    def _cargar_refacciones(self):
        for i in self.tree_refacciones.get_children():
            self.tree_refacciones.delete(i)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT id, codigo, descripcion, precio_unitario FROM refacciones WHERE activo=1 ORDER BY codigo")
        for r in cur.fetchall():
            self.tree_refacciones.insert("", tk.END, values=(r["id"], r["codigo"], (r["descripcion"])[:40], r["precio_unitario"]))
        conn.close()

    def _cargar_maquinas(self, cliente_id=None):
        for i in self.tree_maquinas.get_children():
            self.tree_maquinas.delete(i)
        conn = get_connection()
        cur = conn.cursor()
        if cliente_id:
            cur.execute("SELECT id, codigo, nombre, cliente_id FROM maquinas WHERE activo=1 AND cliente_id=? ORDER BY nombre", (cliente_id,))
        else:
            cur.execute("SELECT id, codigo, nombre, cliente_id FROM maquinas WHERE activo=1 ORDER BY nombre LIMIT 200")
        for r in cur.fetchall():
            self.tree_maquinas.insert("", tk.END, values=(r["id"], r["codigo"] or "", r["nombre"], r["cliente_id"]))
        conn.close()

    def _nuevo_cliente(self):
        self._form_cliente(None)

    def _editar_cliente(self):
        sel = self.tree_clientes.selection()
        if not sel:
            messagebox.showinfo("Info", "Seleccione un cliente.")
            return
        item = self.tree_clientes.item(sel[0])
        cid = item["values"][0]
        self._form_cliente(cid)

    def _form_cliente(self, cliente_id):
        win = tk.Toplevel(self.root)
        win.title("Nuevo cliente" if not cliente_id else "Editar cliente")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        datos = {}
        if cliente_id:
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT * FROM clientes WHERE id=?", (cliente_id,))
            row = cur.fetchone()
            conn.close()
            if row:
                datos = dict(row)
        entries = {}
        for label, key in [("Código", "codigo"), ("Nombre", "nombre"), ("RFC", "rfc"), ("Dirección", "direccion"), ("Teléfono", "telefono"), ("Email", "email")]:
            ttk.Label(f, text=label + ":").grid(row=len(entries), column=0, sticky=tk.W, pady=2)
            e = ttk.Entry(f, width=40)
            e.grid(row=len(entries), column=1, pady=2)
            e.insert(0, datos.get(key) or "")
            entries[key] = e
        def guardar():
            conn = get_connection()
            cur = conn.cursor()
            vals = {k: e.get().strip() for k, e in entries.items()}
            if cliente_id:
                cur.execute("UPDATE clientes SET codigo=?, nombre=?, rfc=?, direccion=?, telefono=?, email=? WHERE id=?",
                            (vals["codigo"], vals["nombre"], vals["rfc"], vals["direccion"], vals["telefono"], vals["email"], cliente_id))
            else:
                cur.execute("INSERT INTO clientes (codigo, nombre, rfc, direccion, telefono, email) VALUES (?,?,?,?,?,?)",
                            (vals["codigo"], vals["nombre"], vals["rfc"], vals["direccion"], vals["telefono"], vals["email"]))
            conn.commit()
            conn.close()
            self._cargar_clientes()
            win.destroy()
            messagebox.showinfo("OK", "Cliente guardado.")
        ttk.Button(f, text="Guardar", command=guardar).grid(row=len(entries), column=1, pady=10)
        win.grab_set()

    def _nueva_refaccion(self):
        self._form_refaccion(None)

    def _editar_refaccion(self):
        sel = self.tree_refacciones.selection()
        if not sel:
            messagebox.showinfo("Info", "Seleccione una refacción.")
            return
        rid = self.tree_refacciones.item(sel[0])["values"][0]
        self._form_refaccion(rid)

    def _form_refaccion(self, refaccion_id):
        win = tk.Toplevel(self.root)
        win.title("Nueva refacción" if not refaccion_id else "Editar refacción")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        datos = {}
        if refaccion_id:
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT * FROM refacciones WHERE id=?", (refaccion_id,))
            row = cur.fetchone()
            conn.close()
            if row:
                datos = dict(row)
        entries = {}
        for label, key in [("Código", "codigo"), ("Descripción", "descripcion"), ("Precio unitario", "precio_unitario"), ("Unidad", "unidad")]:
            ttk.Label(f, text=label + ":").grid(row=len(entries), column=0, sticky=tk.W, pady=2)
            e = ttk.Entry(f, width=40)
            e.grid(row=len(entries), column=1, pady=2)
            val = datos.get(key)
            e.insert(0, str(val) if val is not None else "")
            entries[key] = e
        if "unidad" not in datos or not datos["unidad"]:
            entries["unidad"].insert(0, "PZA")
        def guardar():
            try:
                precio = float(entries["precio_unitario"].get().replace(",", "."))
            except Exception:
                precio = 0
            conn = get_connection()
            cur = conn.cursor()
            if refaccion_id:
                cur.execute("UPDATE refacciones SET codigo=?, descripcion=?, precio_unitario=?, unidad=? WHERE id=?",
                            (entries["codigo"].get().strip(), entries["descripcion"].get().strip(), precio, entries["unidad"].get().strip() or "PZA", refaccion_id))
            else:
                cur.execute("INSERT INTO refacciones (codigo, descripcion, precio_unitario, unidad) VALUES (?,?,?,?)",
                            (entries["codigo"].get().strip(), entries["descripcion"].get().strip(), precio, entries["unidad"].get().strip() or "PZA"))
            conn.commit()
            conn.close()
            self._cargar_refacciones()
            win.destroy()
            messagebox.showinfo("OK", "Refacción guardada.")
        ttk.Button(f, text="Guardar", command=guardar).grid(row=len(entries), column=1, pady=10)
        win.grab_set()

    def _nueva_maquina(self):
        self._form_maquina(None)

    def _editar_maquina(self):
        sel = self.tree_maquinas.selection()
        if not sel:
            messagebox.showinfo("Info", "Seleccione una máquina.")
            return
        mid = self.tree_maquinas.item(sel[0])["values"][0]
        self._form_maquina(mid)

    def _form_maquina(self, maquina_id):
        win = tk.Toplevel(self.root)
        win.title("Nueva máquina" if not maquina_id else "Editar máquina")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        datos = {}
        if maquina_id:
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT * FROM maquinas WHERE id=?", (maquina_id,))
            row = cur.fetchone()
            conn.close()
            if row:
                datos = dict(row)
        cliente_id_var = tk.IntVar(value=datos.get("cliente_id") or 0)
        ttk.Label(f, text="Cliente:").grid(row=0, column=0, sticky=tk.W, pady=2)
        def on_cliente(d):
            cliente_id_var.set(d.get("id", 0))
        ac_cli = AutocompleteEntry(f, ancho=35, buscar_fn=buscar_clientes, on_select=on_cliente)
        ac_cli.grid(row=0, column=1, pady=2)
        if datos.get("cliente_id"):
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT nombre FROM clientes WHERE id=?", (datos["cliente_id"],))
            r = cur.fetchone()
            conn.close()
            if r:
                ac_cli.set(r["nombre"])
        entries = {}
        for i, (label, key) in enumerate([("Código", "codigo"), ("Nombre", "nombre"), ("Modelo", "modelo"), ("Ubicación", "ubicacion")], 1):
            ttk.Label(f, text=label + ":").grid(row=i, column=0, sticky=tk.W, pady=2)
            e = ttk.Entry(f, width=40)
            e.grid(row=i, column=1, pady=2)
            e.insert(0, datos.get(key) or "")
            entries[key] = e
        def guardar():
            cid = cliente_id_var.get()
            if not cid:
                messagebox.showwarning("Aviso", "Seleccione un cliente.")
                return
            conn = get_connection()
            cur = conn.cursor()
            if maquina_id:
                cur.execute("UPDATE maquinas SET cliente_id=?, codigo=?, nombre=?, modelo=?, ubicacion=? WHERE id=?",
                            (cid, entries["codigo"].get().strip(), entries["nombre"].get().strip(), entries["modelo"].get().strip(), entries["ubicacion"].get().strip(), maquina_id))
            else:
                cur.execute("INSERT INTO maquinas (cliente_id, codigo, nombre, modelo, ubicacion) VALUES (?,?,?,?,?)",
                            (cid, entries["codigo"].get().strip(), entries["nombre"].get().strip(), entries["modelo"].get().strip(), entries["ubicacion"].get().strip()))
            conn.commit()
            conn.close()
            self._cargar_maquinas()
            win.destroy()
            messagebox.showinfo("OK", "Máquina guardada.")
        ttk.Button(f, text="Guardar", command=guardar).grid(row=len(entries)+1, column=1, pady=10)
        win.grab_set()

    # --- Cotización Refacciones ---
    def _tab_cotizacion_refacciones(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Cotización Refacciones")
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        ttk.Label(top, text="Cliente:").pack(side=tk.LEFT, padx=(0, 5))
        self.cot_ref_cliente_id = tk.IntVar()
        self.ac_cot_ref_cliente = AutocompleteEntry(top, ancho=40, buscar_fn=buscar_clientes, on_select=self._on_cot_ref_cliente_select)
        self.ac_cot_ref_cliente.pack(side=tk.LEFT, padx=2)
        ttk.Label(top, text="Folio:").pack(side=tk.LEFT, padx=(15, 5))
        self.cot_ref_folio = ttk.Entry(top, width=18)
        self.cot_ref_folio.pack(side=tk.LEFT)
        self.cot_ref_folio.insert(0, generar_folio("COT-REF"))
        ttk.Label(top, text="Fecha:").pack(side=tk.LEFT, padx=(15, 5))
        self.cot_ref_fecha = ttk.Entry(top, width=12)
        self.cot_ref_fecha.pack(side=tk.LEFT)
        self.cot_ref_fecha.insert(0, _fecha_hoy())
        ttk.Button(top, text="Nueva cotización", command=self._cot_ref_limpiar).pack(side=tk.LEFT, padx=15)

        # Datos fiscales (solo lectura visual)
        lf_datos = ttk.LabelFrame(frame, text="Datos del cliente (se completan al elegir)", padding=5)
        lf_datos.pack(fill=tk.X, pady=5)
        f2 = ttk.Frame(lf_datos)
        f2.pack(fill=tk.X)
        ttk.Label(f2, text="RFC:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.cot_ref_rfc = ttk.Label(f2, text="")
        self.cot_ref_rfc.grid(row=0, column=1, sticky=tk.W)
        ttk.Label(f2, text="Dirección:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5))
        self.cot_ref_direccion = ttk.Label(f2, text="")
        self.cot_ref_direccion.grid(row=1, column=1, sticky=tk.W)

        # Líneas
        lf_lin = ttk.LabelFrame(frame, text="Líneas de cotización", padding=5)
        lf_lin.pack(fill=tk.BOTH, expand=True, pady=5)
        ttk.Button(lf_lin, text="+ Agregar refacción", command=self._cot_ref_agregar_linea).pack(anchor=tk.W)
        cols = ("codigo", "descripcion", "cantidad", "precio_unit", "subtotal", "total")
        self.tree_cot_ref = ttk.Treeview(lf_lin, columns=cols, show="headings", height=10)
        for c in cols:
            self.tree_cot_ref.heading(c, text=c.replace("_", " ").title())
            self.tree_cot_ref.column(c, width=100)
        self.tree_cot_ref.pack(fill=tk.BOTH, expand=True)
        ttk.Button(lf_lin, text="Quitar línea", command=self._cot_ref_quitar_linea).pack(anchor=tk.W, pady=2)
        bot = ttk.Frame(lf_lin)
        bot.pack(fill=tk.X)
        self.cot_ref_subtotal_lbl = ttk.Label(bot, text="Subtotal: $0.00")
        self.cot_ref_subtotal_lbl.pack(side=tk.LEFT, padx=5)
        self.cot_ref_iva_lbl = ttk.Label(bot, text="IVA: $0.00")
        self.cot_ref_iva_lbl.pack(side=tk.LEFT, padx=5)
        self.cot_ref_total_lbl = ttk.Label(bot, text="Total: $0.00", font=("", 10, "bold"))
        self.cot_ref_total_lbl.pack(side=tk.LEFT, padx=5)
        ttk.Button(bot, text="Guardar cotización", command=self._cot_ref_guardar).pack(side=tk.LEFT, padx=20)
        ttk.Button(bot, text="Exportar Excel", command=self._cot_ref_exportar_excel).pack(side=tk.LEFT, padx=5)
        ttk.Button(bot, text="Exportar PDF", command=self._cot_ref_exportar_pdf).pack(side=tk.LEFT, padx=5)
        self.cot_ref_lineas = []  # lista de dict con refaccion_id, codigo, descripcion, cantidad, precio_unitario, subtotal, iva, total

    def _on_cot_ref_cliente_select(self, datos):
        self.cot_ref_cliente_id.set(datos.get("id", 0))
        self.cot_ref_rfc.config(text=datos.get("rfc", ""))
        self.cot_ref_direccion.config(text=datos.get("direccion", ""))

    def _cot_ref_agregar_linea(self):
        def pick_ref(d):
            pass
        win = tk.Toplevel(self.root)
        win.title("Agregar refacción")
        f = ttk.Frame(win, padding=10)
        f.pack()
        ttk.Label(f, text="Refacción:").grid(row=0, column=0, sticky=tk.W)
        cant_var = tk.StringVar(value="1")
        precio_var = tk.StringVar(value="0")
        line_data = {}

        def on_ref_select(d):
            line_data.clear()
            line_data.update(d)
            precio_var.set(str(d.get("precio_unitario", 0)))

        ac = AutocompleteEntry(f, ancho=35, buscar_fn=buscar_refacciones, on_select=on_ref_select)
        ac.grid(row=0, column=1)
        ttk.Label(f, text="Cantidad:").grid(row=1, column=0, sticky=tk.W)
        e_cant = ttk.Entry(f, textvariable=cant_var, width=10)
        e_cant.grid(row=1, column=1, sticky=tk.W)
        ttk.Label(f, text="Precio unit.:").grid(row=2, column=0, sticky=tk.W)
        e_precio = ttk.Entry(f, textvariable=precio_var, width=15)
        e_precio.grid(row=2, column=1, sticky=tk.W)

        def agregar():
            try:
                cant = float(cant_var.get().replace(",", "."))
                precio = float(precio_var.get().replace(",", "."))
            except Exception:
                messagebox.showerror("Error", "Cantidad y precio deben ser numéricos.")
                return
            if not line_data.get("id"):
                messagebox.showwarning("Aviso", "Seleccione una refacción del listado.")
                return
            subtotal = cant * precio
            iva = subtotal * IVA_PORCENTAJE
            total = subtotal + iva
            self.cot_ref_lineas.append({
                "refaccion_id": line_data["id"],
                "codigo": line_data.get("codigo", ""),
                "descripcion": line_data.get("descripcion", ""),
                "cantidad": cant,
                "precio_unitario": precio,
                "subtotal": subtotal,
                "iva": iva,
                "total": total,
            })
            self.tree_cot_ref.insert("", tk.END, values=(
                line_data.get("codigo", ""),
                (line_data.get("descripcion", ""))[:30],
                cant,
                f"{precio:.2f}",
                f"{subtotal:.2f}",
                f"{total:.2f}",
            ))
            self._cot_ref_actualizar_totales()
            win.destroy()
        ttk.Button(f, text="Agregar", command=agregar).grid(row=3, column=1, pady=10)
        win.transient(self.root)

    def _cot_ref_quitar_linea(self):
        sel = self.tree_cot_ref.selection()
        if not sel:
            return
        idx = self.tree_cot_ref.index(sel[0])
        self.tree_cot_ref.delete(sel[0])
        if idx < len(self.cot_ref_lineas):
            self.cot_ref_lineas.pop(idx)
        self._cot_ref_actualizar_totales()

    def _cot_ref_actualizar_totales(self):
        st = sum(l["subtotal"] for l in self.cot_ref_lineas)
        iv = sum(l["iva"] for l in self.cot_ref_lineas)
        tot = st + iv
        self.cot_ref_subtotal_lbl.config(text=f"Subtotal: ${st:,.2f}")
        self.cot_ref_iva_lbl.config(text=f"IVA: ${iv:,.2f}")
        self.cot_ref_total_lbl.config(text=f"Total: ${tot:,.2f}")

    def _cot_ref_guardar(self):
        cid = self.cot_ref_cliente_id.get()
        if not cid:
            messagebox.showwarning("Aviso", "Seleccione un cliente.")
            return
        if not self.cot_ref_lineas:
            messagebox.showwarning("Aviso", "Agregue al menos una línea.")
            return
        st = sum(l["subtotal"] for l in self.cot_ref_lineas)
        iv = sum(l["iva"] for l in self.cot_ref_lineas)
        tot = st + iv
        folio = self.cot_ref_folio.get().strip() or generar_folio("COT-REF")
        fecha = self.cot_ref_fecha.get().strip() or _fecha_hoy()
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("INSERT INTO cotizaciones (folio, cliente_id, tipo, fecha, subtotal, iva, total) VALUES (?,?,?,?,?,?,?)",
                    (folio, cid, "refacciones", fecha, st, iv, tot))
        cot_id = cur.lastrowid
        for i, lin in enumerate(self.cot_ref_lineas):
            cur.execute("""INSERT INTO cotizacion_lineas (cotizacion_id, refaccion_id, descripcion, cantidad, precio_unitario, subtotal, iva, total, orden)
                           VALUES (?,?,?,?,?,?,?,?,?)""",
                        (cot_id, lin["refaccion_id"], lin["descripcion"], lin["cantidad"], lin["precio_unitario"], lin["subtotal"], lin["iva"], lin["total"], i))
        conn.commit()
        conn.close()
        messagebox.showinfo("OK", f"Cotización guardada. Folio: {folio}")
        self._cot_ref_limpiar()

    def _cot_ref_limpiar(self):
        self.ac_cot_ref_cliente.clear()
        self.cot_ref_cliente_id.set(0)
        self.cot_ref_rfc.config(text="")
        self.cot_ref_direccion.config(text="")
        self.cot_ref_folio.delete(0, tk.END)
        self.cot_ref_folio.insert(0, generar_folio("COT-REF"))
        self.cot_ref_fecha.delete(0, tk.END)
        self.cot_ref_fecha.insert(0, _fecha_hoy())
        for i in self.tree_cot_ref.get_children():
            self.tree_cot_ref.delete(i)
        self.cot_ref_lineas.clear()
        self._cot_ref_actualizar_totales()

    def _cot_ref_exportar_excel(self):
        if not self.cot_ref_lineas:
            messagebox.showwarning("Aviso", "No hay líneas para exportar.")
            return
        cid = self.cot_ref_cliente_id.get()
        if not cid:
            messagebox.showwarning("Aviso", "Seleccione un cliente.")
            return
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT * FROM clientes WHERE id=?", (cid,))
        cliente = dict(cur.fetchone())
        conn.close()
        cot = {"folio": self.cot_ref_folio.get(), "subtotal": sum(l["subtotal"] for l in self.cot_ref_lineas),
               "iva": sum(l["iva"] for l in self.cot_ref_lineas), "total": sum(l["total"] for l in self.cot_ref_lineas)}
        lineas = [dict(l) for l in self.cot_ref_lineas]
        ruta = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel", "*.xlsx")])
        if ruta:
            try:
                exportar_cotizacion_excel(cot, lineas, cliente, ruta)
                messagebox.showinfo("OK", f"Exportado: {ruta}")
            except Exception as e:
                messagebox.showerror("Error", str(e))

    def _cot_ref_exportar_pdf(self):
        if not self.cot_ref_lineas:
            messagebox.showwarning("Aviso", "No hay líneas para exportar.")
            return
        cid = self.cot_ref_cliente_id.get()
        if not cid:
            messagebox.showwarning("Aviso", "Seleccione un cliente.")
            return
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT * FROM clientes WHERE id=?", (cid,))
        cliente = dict(cur.fetchone())
        conn.close()
        cot = {"folio": self.cot_ref_folio.get(), "subtotal": sum(l["subtotal"] for l in self.cot_ref_lineas),
               "iva": sum(l["iva"] for l in self.cot_ref_lineas), "total": sum(l["total"] for l in self.cot_ref_lineas)}
        lineas = [dict(l) for l in self.cot_ref_lineas]
        ruta = filedialog.asksaveasfilename(defaultextension=".pdf", filetypes=[("PDF", "*.pdf")])
        if ruta:
            try:
                exportar_cotizacion_pdf(cot, lineas, cliente, ruta)
                messagebox.showinfo("OK", f"Exportado: {ruta}")
            except Exception as e:
                messagebox.showerror("Error", str(e))

    # --- Cotización Mano de Obra ---
    def _tab_cotizacion_mano_obra(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Cotización Mano de Obra")
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        ttk.Label(top, text="Cliente:").pack(side=tk.LEFT, padx=(0, 5))
        self.cot_mo_cliente_id = tk.IntVar()
        self.ac_cot_mo_cliente = AutocompleteEntry(top, ancho=40, buscar_fn=buscar_clientes, on_select=lambda d: self.cot_mo_cliente_id.set(d.get("id", 0)))
        self.ac_cot_mo_cliente.pack(side=tk.LEFT, padx=2)
        ttk.Label(top, text="Folio:").pack(side=tk.LEFT, padx=(15, 5))
        self.cot_mo_folio = ttk.Entry(top, width=18)
        self.cot_mo_folio.pack(side=tk.LEFT)
        self.cot_mo_folio.insert(0, generar_folio("COT-MO"))
        ttk.Label(top, text="Fecha:").pack(side=tk.LEFT, padx=(15, 5))
        self.cot_mo_fecha = ttk.Entry(top, width=12)
        self.cot_mo_fecha.pack(side=tk.LEFT)
        self.cot_mo_fecha.insert(0, _fecha_hoy())
        lf_mo = ttk.LabelFrame(frame, text="Detalle mano de obra", padding=5)
        lf_mo.pack(fill=tk.X, pady=5)
        f = ttk.Frame(lf_mo)
        f.pack(fill=tk.X)
        ttk.Label(f, text="Técnico:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.cot_mo_tecnico = ttk.Entry(f, width=25)
        self.cot_mo_tecnico.grid(row=0, column=1, padx=2)
        ttk.Label(f, text="Horas:").grid(row=0, column=2, sticky=tk.W, padx=(15, 5))
        self.cot_mo_horas = ttk.Entry(f, width=8)
        self.cot_mo_horas.grid(row=0, column=3, padx=2)
        self.cot_mo_horas.insert(0, "1")
        ttk.Label(f, text="Tarifa/hora:").grid(row=0, column=4, sticky=tk.W, padx=(15, 5))
        self.cot_mo_tarifa = ttk.Entry(f, width=12)
        self.cot_mo_tarifa.grid(row=0, column=5, padx=2)
        self.cot_mo_tarifa.insert(0, "500")
        ttk.Label(f, text="Descuento %:").grid(row=0, column=6, sticky=tk.W, padx=(15, 5))
        self.cot_mo_descuento = ttk.Entry(f, width=6)
        self.cot_mo_descuento.grid(row=0, column=7, padx=2)
        self.cot_mo_descuento.insert(0, "0")
        ttk.Label(f, text="Descripción:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))
        self.cot_mo_desc = ttk.Entry(f, width=60)
        self.cot_mo_desc.grid(row=1, column=1, columnspan=6, sticky=tk.EW, padx=2, pady=(5, 0))
        self.cot_mo_lineas = []
        self.tree_cot_mo = ttk.Treeview(lf_mo, columns=("tecnico", "horas", "tarifa", "descuento", "subtotal", "total"), show="headings", height=6)
        for c in ("tecnico", "horas", "tarifa", "descuento", "subtotal", "total"):
            self.tree_cot_mo.heading(c, text=c.title())
            self.tree_cot_mo.column(c, width=90)
        self.tree_cot_mo.pack(fill=tk.X, pady=5)
        ttk.Button(lf_mo, text="+ Agregar línea", command=self._cot_mo_agregar).pack(anchor=tk.W)
        bot = ttk.Frame(lf_mo)
        bot.pack(fill=tk.X)
        self.cot_mo_total_lbl = ttk.Label(bot, text="Total: $0.00", font=("", 10, "bold"))
        self.cot_mo_total_lbl.pack(side=tk.LEFT, padx=5)
        ttk.Button(bot, text="Guardar cotización", command=self._cot_mo_guardar).pack(side=tk.LEFT, padx=15)
        ttk.Button(bot, text="Exportar Excel", command=self._cot_mo_exportar).pack(side=tk.LEFT, padx=5)

    def _cot_mo_agregar(self):
        try:
            horas = float(self.cot_mo_horas.get().replace(",", "."))
            tarifa = float(self.cot_mo_tarifa.get().replace(",", "."))
            desc = float(self.cot_mo_descuento.get().replace(",", ".") or "0")
        except Exception:
            messagebox.showerror("Error", "Horas, tarifa y descuento deben ser numéricos.")
            return
        subtotal = horas * tarifa
        total = subtotal * (1 - desc / 100)
        self.cot_mo_lineas.append({
            "descripcion": self.cot_mo_desc.get().strip() or "Mano de obra",
            "tecnico": self.cot_mo_tecnico.get().strip(),
            "horas": horas,
            "tarifa": tarifa,
            "descuento": desc,
            "subtotal": subtotal,
            "total": total,
        })
        self.tree_cot_mo.insert("", tk.END, values=(
            self.cot_mo_tecnico.get().strip(),
            horas,
            tarifa,
            f"{desc}%",
            f"{subtotal:.2f}",
            f"{total:.2f}",
        ))
        tot = sum(l["total"] for l in self.cot_mo_lineas)
        self.cot_mo_total_lbl.config(text=f"Total: ${tot:,.2f}")

    def _cot_mo_guardar(self):
        cid = self.cot_mo_cliente_id.get()
        if not cid:
            messagebox.showwarning("Aviso", "Seleccione un cliente.")
            return
        if not self.cot_mo_lineas:
            messagebox.showwarning("Aviso", "Agregue al menos una línea.")
            return
        tot = sum(l["total"] for l in self.cot_mo_lineas)
        iva = tot * IVA_PORCENTAJE
        subtotal = tot
        total_con_iva = tot + iva
        folio = self.cot_mo_folio.get().strip() or generar_folio("COT-MO")
        fecha = self.cot_mo_fecha.get().strip() or _fecha_hoy()
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("INSERT INTO cotizaciones (folio, cliente_id, tipo, fecha, subtotal, iva, total) VALUES (?,?,?,?,?,?,?)",
                    (folio, cid, "mano_obra", fecha, subtotal, iva, total_con_iva))
        cot_id = cur.lastrowid
        for i, lin in enumerate(self.cot_mo_lineas):
            cur.execute("""INSERT INTO cotizacion_lineas (cotizacion_id, descripcion, cantidad, precio_unitario, subtotal, iva, total, orden)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        (cot_id, lin["descripcion"], lin["horas"], lin["tarifa"], lin["subtotal"], 0, lin["total"], i))
        conn.commit()
        conn.close()
        messagebox.showinfo("OK", f"Cotización guardada. Folio: {folio}")
        for i in self.tree_cot_mo.get_children():
            self.tree_cot_mo.delete(i)
        self.cot_mo_lineas.clear()
        self.cot_mo_total_lbl.config(text="Total: $0.00")

    def _cot_mo_exportar(self):
        if not self.cot_mo_lineas:
            messagebox.showwarning("Aviso", "No hay líneas para exportar.")
            return
        cid = self.cot_mo_cliente_id.get()
        if not cid:
            messagebox.showwarning("Aviso", "Seleccione un cliente.")
            return
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT * FROM clientes WHERE id=?", (cid,))
        cliente = dict(cur.fetchone())
        conn.close()
        tot = sum(l["total"] for l in self.cot_mo_lineas)
        iva = tot * IVA_PORCENTAJE
        cot = {"folio": self.cot_mo_folio.get(), "subtotal": tot, "iva": iva, "total": tot + iva}
        lineas = [{"codigo": "", "descripcion": l["descripcion"], "cantidad": l["horas"], "precio_unitario": l["tarifa"], "subtotal": l["subtotal"], "total": l["total"]} for l in self.cot_mo_lineas]
        ruta = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel", "*.xlsx")])
        if ruta:
            try:
                exportar_cotizacion_excel(cot, lineas, cliente, ruta)
                messagebox.showinfo("OK", f"Exportado: {ruta}")
            except Exception as e:
                messagebox.showerror("Error", str(e))

    # --- Incidentes ---
    def _tab_incidentes(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Incidentes")
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        ttk.Button(top, text="+ Nuevo incidente", command=self._nuevo_incidente).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="Refrescar", command=self._cargar_incidentes).pack(side=tk.LEFT, padx=2)
        cols = ("id", "folio", "cliente", "maquina", "descripcion", "prioridad", "fecha", "estatus")
        self.tree_incidentes = ttk.Treeview(frame, columns=cols, show="headings", height=12)
        for c in cols:
            self.tree_incidentes.heading(c, text=c.capitalize())
            self.tree_incidentes.column(c, width=80 if c in ("id", "folio", "prioridad", "estatus") else 150)
        self.tree_incidentes.pack(fill=tk.BOTH, expand=True, pady=5)
        self._cargar_incidentes()

    def _cargar_incidentes(self):
        for i in self.tree_incidentes.get_children():
            self.tree_incidentes.delete(i)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT i.id, i.folio, c.nombre as cliente, m.nombre as maquina, i.descripcion, i.prioridad, i.fecha_reporte, i.estatus
            FROM incidentes i
            JOIN clientes c ON c.id = i.cliente_id
            LEFT JOIN maquinas m ON m.id = i.maquina_id
            ORDER BY i.fecha_reporte DESC
            LIMIT 300
        """)
        for r in cur.fetchall():
            self.tree_incidentes.insert("", tk.END, values=(
                r["id"], r["folio"] or "", (r["cliente"] or "")[:20], (r["maquina"] or "")[:15],
                (r["descripcion"] or "")[:30], r["prioridad"] or "", r["fecha_reporte"], r["estatus"] or ""
            ))
        conn.close()

    def _nuevo_incidente(self):
        win = tk.Toplevel(self.root)
        win.title("Nuevo incidente")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        cliente_id_var = tk.IntVar()
        maquina_id_var = tk.IntVar()
        ttk.Label(f, text="Cliente:").grid(row=0, column=0, sticky=tk.W, pady=2)
        ac_cli = AutocompleteEntry(f, ancho=35, buscar_fn=buscar_clientes, on_select=lambda d: (cliente_id_var.set(d.get("id", 0)), maquina_id_var.set(0)))
        ac_cli.grid(row=0, column=1, pady=2)
        ttk.Label(f, text="Máquina:").grid(row=1, column=0, sticky=tk.W, pady=2)
        def busq_maq(t):
            return buscar_maquinas(t, cliente_id_var.get() if cliente_id_var.get() else None)
        ac_maq = AutocompleteEntry(f, ancho=35, buscar_fn=busq_maq, on_select=lambda d: maquina_id_var.set(d.get("id", 0)))
        ac_maq.grid(row=1, column=1, pady=2)
        ttk.Label(f, text="Descripción:").grid(row=2, column=0, sticky=tk.W, pady=2)
        e_desc = scrolledtext.ScrolledText(f, width=45, height=3)
        e_desc.grid(row=2, column=1, pady=2)
        ttk.Label(f, text="Prioridad:").grid(row=3, column=0, sticky=tk.W, pady=2)
        combo_prio = ttk.Combobox(f, values=["baja", "media", "alta", "critica"], width=15, state="readonly")
        combo_prio.grid(row=3, column=1, sticky=tk.W, pady=2)
        combo_prio.set("media")
        ttk.Label(f, text="Técnico:").grid(row=4, column=0, sticky=tk.W, pady=2)
        e_tec = ttk.Entry(f, width=25)
        e_tec.grid(row=4, column=1, sticky=tk.W, pady=2)
        ttk.Label(f, text="Fecha:").grid(row=5, column=0, sticky=tk.W, pady=2)
        e_fecha = ttk.Entry(f, width=12)
        e_fecha.grid(row=5, column=1, sticky=tk.W, pady=2)
        e_fecha.insert(0, _fecha_hoy())
        def guardar():
            if not cliente_id_var.get():
                messagebox.showwarning("Aviso", "Seleccione un cliente.")
                return
            desc = e_desc.get("1.0", tk.END).strip()
            if not desc:
                messagebox.showwarning("Aviso", "Escriba una descripción.")
                return
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*)+1 FROM incidentes WHERE fecha_reporte = date('now','localtime')")
            n = cur.fetchone()[0]
            folio = f"INC-{datetime.now().strftime('%Y%m%d')}-{n:04d}"
            cur.execute("""INSERT INTO incidentes (folio, cliente_id, maquina_id, descripcion, prioridad, fecha_reporte, tecnico_responsable)
                           VALUES (?,?,?,?,?,?,?)""",
                        (folio, cliente_id_var.get(), maquina_id_var.get() or None, desc, combo_prio.get(), e_fecha.get().strip(), e_tec.get().strip() or None))
            conn.commit()
            conn.close()
            self._cargar_incidentes()
            win.destroy()
            messagebox.showinfo("OK", "Incidente registrado.")
        ttk.Button(f, text="Guardar", command=guardar).grid(row=6, column=1, pady=10)
        win.grab_set()

    # --- Bitácoras ---
    def _tab_bitacoras(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Bitácoras de Trabajo")
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        ttk.Button(top, text="+ Nueva bitácora", command=self._nueva_bitacora).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="Refrescar", command=self._cargar_bitacoras).pack(side=tk.LEFT, padx=2)
        cols = ("id", "fecha", "incidente_id", "cotizacion_id", "tecnico", "actividades", "tiempo_hrs")
        self.tree_bitacoras = ttk.Treeview(frame, columns=cols, show="headings", height=12)
        for c in cols:
            self.tree_bitacoras.heading(c, text=c.replace("_", " ").title())
            self.tree_bitacoras.column(c, width=80 if c == "id" else 120)
        self.tree_bitacoras.pack(fill=tk.BOTH, expand=True, pady=5)
        self._cargar_bitacoras()

    def _cargar_bitacoras(self):
        for i in self.tree_bitacoras.get_children():
            self.tree_bitacoras.delete(i)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT id, fecha, incidente_id, cotizacion_id, tecnico, actividades, tiempo_horas FROM bitacoras ORDER BY fecha DESC LIMIT 200")
        for r in cur.fetchall():
            self.tree_bitacoras.insert("", tk.END, values=(
                r["id"], r["fecha"], r["incidente_id"] or "", r["cotizacion_id"] or "",
                r["tecnico"] or "", (r["actividades"] or "")[:25], r["tiempo_horas"] or 0
            ))
        conn.close()

    def _nueva_bitacora(self):
        win = tk.Toplevel(self.root)
        win.title("Nueva bitácora")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        inc_id_var = tk.IntVar()
        cot_id_var = tk.IntVar()
        ttk.Label(f, text="Incidente (opcional):").grid(row=0, column=0, sticky=tk.W, pady=2)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT id, folio FROM incidentes ORDER BY id DESC LIMIT 50")
        incs = list(cur.fetchall())
        conn.close()
        combo_inc = ttk.Combobox(f, values=[f"{r['id']} - {r['folio']}" for r in incs], width=25, state="readonly")
        combo_inc.grid(row=0, column=1, pady=2)
        ttk.Label(f, text="Cotización (opcional):").grid(row=1, column=0, sticky=tk.W, pady=2)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT id, folio FROM cotizaciones ORDER BY id DESC LIMIT 50")
        cots = list(cur.fetchall())
        conn.close()
        combo_cot = ttk.Combobox(f, values=[f"{r['id']} - {r['folio']}" for r in cots], width=25, state="readonly")
        combo_cot.grid(row=1, column=1, pady=2)
        ttk.Label(f, text="Fecha:").grid(row=2, column=0, sticky=tk.W, pady=2)
        e_fecha = ttk.Entry(f, width=12)
        e_fecha.grid(row=2, column=1, sticky=tk.W, pady=2)
        e_fecha.insert(0, _fecha_hoy())
        ttk.Label(f, text="Técnico:").grid(row=3, column=0, sticky=tk.W, pady=2)
        e_tec = ttk.Entry(f, width=25)
        e_tec.grid(row=3, column=1, sticky=tk.W, pady=2)
        ttk.Label(f, text="Actividades:").grid(row=4, column=0, sticky=tk.W, pady=2)
        e_act = scrolledtext.ScrolledText(f, width=45, height=3)
        e_act.grid(row=4, column=1, pady=2)
        ttk.Label(f, text="Tiempo (hrs):").grid(row=5, column=0, sticky=tk.W, pady=2)
        e_tiempo = ttk.Entry(f, width=8)
        e_tiempo.grid(row=5, column=1, sticky=tk.W, pady=2)
        e_tiempo.insert(0, "0")
        ttk.Label(f, text="Materiales usados:").grid(row=6, column=0, sticky=tk.W, pady=2)
        e_mat = ttk.Entry(f, width=45)
        e_mat.grid(row=6, column=1, pady=2)
        def guardar():
            inc_sel = combo_inc.get()
            cot_sel = combo_cot.get()
            inc_id = int(inc_sel.split(" - ")[0]) if inc_sel and " - " in inc_sel else None
            cot_id = int(cot_sel.split(" - ")[0]) if cot_sel and " - " in cot_sel else None
            if not inc_id and not cot_id:
                messagebox.showwarning("Aviso", "Indique incidente o cotización.")
                return
            try:
                tiempo = float(e_tiempo.get().replace(",", "."))
            except Exception:
                tiempo = 0
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("""INSERT INTO bitacoras (incidente_id, cotizacion_id, fecha, tecnico, actividades, tiempo_horas, materiales_usados)
                           VALUES (?,?,?,?,?,?,?)""",
                        (inc_id, cot_id, e_fecha.get().strip(), e_tec.get().strip() or None, e_act.get("1.0", tk.END).strip(), tiempo, e_mat.get().strip() or None))
            conn.commit()
            conn.close()
            self._cargar_bitacoras()
            win.destroy()
            messagebox.showinfo("OK", "Bitácora guardada.")
        ttk.Button(f, text="Guardar", command=guardar).grid(row=7, column=1, pady=10)
        win.grab_set()

    # --- Mantenimientos ---
    def _tab_mantenimientos(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Mantenimiento de Equipos")
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        ttk.Button(top, text="Plan preventivo por máquina", command=self._plan_mantenimiento).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="Registrar mantenimiento", command=self._registrar_mantenimiento).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="Refrescar", command=self._cargar_mantenimientos).pack(side=tk.LEFT, padx=2)
        cols = ("id", "maquina", "tipo", "fecha_prog", "fecha_fin", "tecnico", "costo")
        self.tree_mantenimientos = ttk.Treeview(frame, columns=cols, show="headings", height=10)
        for c in cols:
            self.tree_mantenimientos.heading(c, text=c.replace("_", " ").title())
            self.tree_mantenimientos.column(c, width=90)
        self.tree_mantenimientos.pack(fill=tk.BOTH, expand=True, pady=5)
        lf_alertas = ttk.LabelFrame(frame, text="Alertas (próximos/vencidos)", padding=5)
        lf_alertas.pack(fill=tk.X, pady=5)
        self.lbl_alertas = ttk.Label(lf_alertas, text="Sin alertas.")
        self.lbl_alertas.pack(anchor=tk.W)
        self._cargar_mantenimientos()
        self._actualizar_alertas()

    def _cargar_mantenimientos(self):
        for i in self.tree_mantenimientos.get_children():
            self.tree_mantenimientos.delete(i)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT m.id, ma.nombre as maquina, m.tipo, m.fecha_programada as fecha_prog, m.fecha_fin, m.tecnico, m.costo_total as costo
            FROM mantenimientos m
            JOIN maquinas ma ON ma.id = m.maquina_id
            ORDER BY m.fecha_programada DESC, m.id DESC
            LIMIT 200
        """)
        for r in cur.fetchall():
            self.tree_mantenimientos.insert("", tk.END, values=(
                r["id"], (r["maquina"] or "")[:20], r["tipo"], r["fecha_prog"] or "", r["fecha_fin"] or "",
                (r["tecnico"] or "")[:15], r["costo"] or 0
            ))
        conn.close()

    def _actualizar_alertas(self):
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT mp.id, ma.nombre, mp.proxima_fecha, mp.tipo
            FROM mantenimiento_plan mp
            JOIN maquinas ma ON ma.id = mp.maquina_id
            WHERE mp.activo=1 AND mp.proxima_fecha IS NOT NULL
            ORDER BY mp.proxima_fecha
            LIMIT 10
        """)
        rows = cur.fetchall()
        conn.close()
        if not rows:
            self.lbl_alertas.config(text="Sin alertas de mantenimiento preventivo.")
            return
        hoy = _fecha_hoy()
        alertas = []
        for r in rows:
            pf = r["proxima_fecha"]
            if pf and pf <= hoy:
                alertas.append(f"Vencido: {r['nombre']} ({r['tipo']}) - {pf}")
            else:
                alertas.append(f"Próximo: {r['nombre']} ({r['tipo']}) - {pf}")
        self.lbl_alertas.config(text="\n".join(alertas[:5]))

    def _plan_mantenimiento(self):
        win = tk.Toplevel(self.root)
        win.title("Plan de mantenimiento preventivo")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        maquina_id_var = tk.IntVar()
        ttk.Label(f, text="Máquina:").grid(row=0, column=0, sticky=tk.W, pady=2)
        ac_maq = AutocompleteEntry(f, ancho=35, buscar_fn=buscar_maquinas, on_select=lambda d: maquina_id_var.set(d.get("id", 0)))
        ac_maq.grid(row=0, column=1, pady=2)
        ttk.Label(f, text="Tipo frecuencia:").grid(row=1, column=0, sticky=tk.W, pady=2)
        combo_tipo = ttk.Combobox(f, values=["diario", "semanal", "mensual", "anual"], width=15, state="readonly")
        combo_tipo.grid(row=1, column=1, sticky=tk.W, pady=2)
        combo_tipo.set("mensual")
        ttk.Label(f, text="Días entre mantenimientos:").grid(row=2, column=0, sticky=tk.W, pady=2)
        e_dias = ttk.Entry(f, width=8)
        e_dias.grid(row=2, column=1, sticky=tk.W, pady=2)
        e_dias.insert(0, "30")
        ttk.Label(f, text="Descripción:").grid(row=3, column=0, sticky=tk.W, pady=2)
        e_desc = ttk.Entry(f, width=40)
        e_desc.grid(row=3, column=1, pady=2)
        def guardar():
            if not maquina_id_var.get():
                messagebox.showwarning("Aviso", "Seleccione una máquina.")
                return
            try:
                dias = int(e_dias.get())
            except Exception:
                dias = 30
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("""INSERT INTO mantenimiento_plan (maquina_id, tipo, descripcion, dias_frecuencia, activo) VALUES (?,?,?,?,1)""",
                        (maquina_id_var.get(), combo_tipo.get(), e_desc.get().strip(), dias))
            conn.commit()
            conn.close()
            win.destroy()
            messagebox.showinfo("OK", "Plan de mantenimiento creado.")
            self._actualizar_alertas()
        ttk.Button(f, text="Guardar", command=guardar).grid(row=4, column=1, pady=10)
        win.grab_set()

    def _registrar_mantenimiento(self):
        win = tk.Toplevel(self.root)
        win.title("Registrar mantenimiento")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack(fill=tk.BOTH, expand=True)
        maquina_id_var = tk.IntVar()
        ttk.Label(f, text="Máquina:").grid(row=0, column=0, sticky=tk.W, pady=2)
        ac_maq = AutocompleteEntry(f, ancho=35, buscar_fn=buscar_maquinas, on_select=lambda d: maquina_id_var.set(d.get("id", 0)))
        ac_maq.grid(row=0, column=1, pady=2)
        ttk.Label(f, text="Tipo:").grid(row=1, column=0, sticky=tk.W, pady=2)
        combo_tipo = ttk.Combobox(f, values=["preventivo", "correctivo"], width=15, state="readonly")
        combo_tipo.grid(row=1, column=1, sticky=tk.W, pady=2)
        combo_tipo.set("correctivo")
        ttk.Label(f, text="Fecha:").grid(row=2, column=0, sticky=tk.W, pady=2)
        e_fecha = ttk.Entry(f, width=12)
        e_fecha.grid(row=2, column=1, sticky=tk.W, pady=2)
        e_fecha.insert(0, _fecha_hoy())
        ttk.Label(f, text="Descripción falla (correctivo):").grid(row=3, column=0, sticky=tk.W, pady=2)
        e_falla = scrolledtext.ScrolledText(f, width=40, height=2)
        e_falla.grid(row=3, column=1, pady=2)
        ttk.Label(f, text="Causa raíz:").grid(row=4, column=0, sticky=tk.W, pady=2)
        e_causa = ttk.Entry(f, width=40)
        e_causa.grid(row=4, column=1, pady=2)
        ttk.Label(f, text="Acción tomada:").grid(row=5, column=0, sticky=tk.W, pady=2)
        e_accion = scrolledtext.ScrolledText(f, width=40, height=2)
        e_accion.grid(row=5, column=1, pady=2)
        ttk.Label(f, text="Técnico:").grid(row=6, column=0, sticky=tk.W, pady=2)
        e_tec = ttk.Entry(f, width=25)
        e_tec.grid(row=6, column=1, sticky=tk.W, pady=2)
        ttk.Label(f, text="Horas invertidas:").grid(row=7, column=0, sticky=tk.W, pady=2)
        e_horas = ttk.Entry(f, width=8)
        e_horas.grid(row=7, column=1, sticky=tk.W, pady=2)
        e_horas.insert(0, "0")
        ttk.Label(f, text="Costo refacciones:").grid(row=8, column=0, sticky=tk.W, pady=2)
        e_costo = ttk.Entry(f, width=12)
        e_costo.grid(row=8, column=1, sticky=tk.W, pady=2)
        e_costo.insert(0, "0")
        def guardar():
            if not maquina_id_var.get():
                messagebox.showwarning("Aviso", "Seleccione una máquina.")
                return
            try:
                horas = float(e_horas.get().replace(",", "."))
                costo = float(e_costo.get().replace(",", "."))
            except Exception:
                horas, costo = 0, 0
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("""INSERT INTO mantenimientos (maquina_id, tipo, fecha_inicio, fecha_fin, descripcion_falla, causa_raiz, accion_tomada, tecnico, horas_invertidas, costo_refacciones, costo_total)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (maquina_id_var.get(), combo_tipo.get(), e_fecha.get(), e_fecha.get(),
                         e_falla.get("1.0", tk.END).strip(), e_causa.get().strip(), e_accion.get("1.0", tk.END).strip(),
                         e_tec.get().strip() or None, horas, costo, costo))
            conn.commit()
            conn.close()
            win.destroy()
            messagebox.showinfo("OK", "Mantenimiento registrado.")
            self._cargar_mantenimientos()
        ttk.Button(f, text="Guardar", command=guardar).grid(row=9, column=1, pady=10)
        win.grab_set()

    # --- Historial / Drill-down ---
    def _tab_historial(self):
        frame = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(frame, text="Historial por Cliente")
        top = ttk.Frame(frame)
        top.pack(fill=tk.X)
        ttk.Label(top, text="Cliente:").pack(side=tk.LEFT, padx=(0, 5))
        self.ac_hist_cliente = AutocompleteEntry(top, ancho=40, buscar_fn=buscar_clientes, on_select=self._on_hist_cliente)
        self.ac_hist_cliente.pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="Ver historial", command=self._ver_historial).pack(side=tk.LEFT, padx=15)
        self.hist_cliente_id = tk.IntVar()
        lf = ttk.LabelFrame(frame, text="Cotizaciones · Incidentes · Bitácoras", padding=5)
        lf.pack(fill=tk.BOTH, expand=True, pady=5)
        self.txt_historial = scrolledtext.ScrolledText(lf, width=90, height=20, font=("Consolas", 9))
        self.txt_historial.pack(fill=tk.BOTH, expand=True)
        ttk.Button(frame, text="Exportar mantenimientos de máquina a Excel", command=self._exportar_mant_maquina).pack(anchor=tk.W, pady=5)

    def _on_hist_cliente(self, datos):
        self.hist_cliente_id.set(datos.get("id", 0))

    def _ver_historial(self):
        cid = self.hist_cliente_id.get()
        if not cid:
            messagebox.showwarning("Aviso", "Seleccione un cliente.")
            return
        self.txt_historial.delete("1.0", tk.END)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT nombre FROM clientes WHERE id=?", (cid,))
        r = cur.fetchone()
        nombre_cli = r["nombre"] if r else ""
        self.txt_historial.insert(tk.END, f"=== HISTORIAL CLIENTE: {nombre_cli} ===\n\n")
        cur.execute("SELECT folio, tipo, fecha, total FROM cotizaciones WHERE cliente_id=? ORDER BY fecha DESC", (cid,))
        self.txt_historial.insert(tk.END, "COTIZACIONES:\n")
        for row in cur.fetchall():
            self.txt_historial.insert(tk.END, f"  {row['folio']} | {row['tipo']} | {row['fecha']} | ${row['total']:,.2f}\n")
        cur.execute("SELECT i.folio, i.descripcion, i.fecha_reporte, i.estatus FROM incidentes i WHERE i.cliente_id=? ORDER BY i.fecha_reporte DESC", (cid,))
        self.txt_historial.insert(tk.END, "\nINCIDENTES:\n")
        for row in cur.fetchall():
            self.txt_historial.insert(tk.END, f"  {row['folio']} | {row['fecha_reporte']} | {row['estatus']} | {(row['descripcion'] or '')[:50]}\n")
        cur.execute("""SELECT b.fecha, b.tecnico, b.actividades, b.tiempo_horas FROM bitacoras b
                      JOIN incidentes i ON i.id = b.incidente_id WHERE i.cliente_id=? ORDER BY b.fecha DESC""", (cid,))
        self.txt_historial.insert(tk.END, "\nBITÁCORAS (por incidentes del cliente):\n")
        for row in cur.fetchall():
            self.txt_historial.insert(tk.END, f"  {row['fecha']} | {row['tecnico'] or '-'} | {(row['actividades'] or '')[:40]} | {row['tiempo_horas']} hrs\n")
        conn.close()

    def _exportar_mant_maquina(self):
        win = tk.Toplevel(self.root)
        win.title("Exportar mantenimientos por máquina")
        win.transient(self.root)
        f = ttk.Frame(win, padding=15)
        f.pack()
        maquina_id_var = tk.IntVar()
        maquina_nombre_var = tk.StringVar()
        ttk.Label(f, text="Máquina:").grid(row=0, column=0, sticky=tk.W)
        def on_maq(d):
            maquina_id_var.set(d.get("id", 0))
            maquina_nombre_var.set(d.get("nombre", ""))
        ac = AutocompleteEntry(f, ancho=35, buscar_fn=buscar_maquinas, on_select=on_maq)
        ac.grid(row=0, column=1)
        def exportar():
            mid = maquina_id_var.get()
            if not mid:
                messagebox.showwarning("Aviso", "Seleccione una máquina.")
                return
            conn = get_connection()
            cur = conn.cursor()
            cur.execute("SELECT nombre FROM maquinas WHERE id=?", (mid,))
            r = cur.fetchone()
            nombre = r["nombre"] if r else "Máquina"
            cur.execute("SELECT fecha_fin, fecha_inicio, tipo, descripcion_falla, accion_tomada, tecnico, horas_invertidas, costo_total FROM mantenimientos WHERE maquina_id=? ORDER BY fecha_fin DESC", (mid,))
            regs = [dict(row) for row in cur.fetchall()]
            conn.close()
            ruta = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel", "*.xlsx")])
            if ruta:
                try:
                    exportar_mantenimientos_excel(nombre, regs, ruta)
                    messagebox.showinfo("OK", f"Exportado: {ruta}")
                except Exception as e:
                    messagebox.showerror("Error", str(e))
            win.destroy()
        ttk.Button(f, text="Exportar Excel", command=exportar).grid(row=1, column=1, pady=10)
        win.grab_set()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    App().run()
