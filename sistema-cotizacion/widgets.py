# -*- coding: utf-8 -*-
"""Widgets reutilizables: autocompletado, etc."""
import tkinter as tk
from tkinter import ttk, Listbox


class AutocompleteEntry(ttk.Frame):
    """
    Entrada con autocompletado. Recibe una función:
    buscar( texto ) -> lista de (valor, dict_datos)
    Al seleccionar se llama on_select(datos).
    """
    def __init__(self, parent, ancho=30, buscar_fn=None, on_select=None, **kwargs):
        super().__init__(parent, **kwargs)
        self.buscar_fn = buscar_fn or (lambda t: [])
        self.on_select = on_select or (lambda d: None)
        self._datos_actuales = []
        self._listbox_visible = False

        self.entry = ttk.Entry(self, width=ancho)
        self.entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.entry.bind("<KeyRelease>", self._on_key)
        self.entry.bind("<FocusOut>", self._on_focus_out)
        self.entry.bind("<Down>", self._on_down)
        self.entry.bind("<Up>", self._on_up)
        self.entry.bind("<Return>", self._on_return)

        self.listbox = Listbox(self, height=6, font=("Segoe UI", 9))
        self.listbox.bind("<<ListboxSelect>>", self._on_list_select)
        self.listbox.bind("<Return>", self._on_return)

    def _on_key(self, event):
        if event.keysym in ("Up", "Down", "Return"):
            return
        texto = self.entry.get().strip()
        self._actualizar_lista(texto)

    def _actualizar_lista(self, texto):
        self.listbox.delete(0, tk.END)
        self._datos_actuales = []
        if len(texto) < 1:
            self._ocultar_lista()
            return
        resultados = self.buscar_fn(texto)
        self._datos_actuales = resultados
        if not resultados:
            self._ocultar_lista()
            return
        for item in resultados[:15]:
            if isinstance(item, (list, tuple)):
                self.listbox.insert(tk.END, item[0])
            else:
                self.listbox.insert(tk.END, str(item))
        self._mostrar_lista()

    def _mostrar_lista(self):
        if not self._listbox_visible:
            self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
            self._listbox_visible = True

    def _ocultar_lista(self):
        self.listbox.pack_forget()
        self._listbox_visible = False

    def _on_focus_out(self, event):
        # Dar tiempo a que el clic en listbox se registre
        self.after(200, self._ocultar_lista)

    def _on_down(self, event):
        if self._listbox_visible and self._datos_actuales:
            self.listbox.focus_set()
            self.listbox.selection_set(0)
            self.listbox.see(0)

    def _on_up(self, event):
        if self._listbox_visible:
            self.listbox.focus_set()

    def _on_return(self, event=None):
        if self._listbox_visible and self.listbox.curselection():
            idx = self.listbox.curselection()[0]
            if idx < len(self._datos_actuales):
                self._seleccionar(idx)
        return "break"

    def _on_list_select(self, event):
        if self.listbox.curselection():
            idx = self.listbox.curselection()[0]
            self._seleccionar(idx)

    def _seleccionar(self, idx):
        if idx >= len(self._datos_actuales):
            return
        item = self._datos_actuales[idx]
        if isinstance(item, (list, tuple)):
            self.entry.delete(0, tk.END)
            self.entry.insert(0, item[0])
            self.on_select(item[1] if len(item) > 1 else {})
        else:
            self.entry.delete(0, tk.END)
            self.entry.insert(0, str(item))
            self.on_select({})
        self._ocultar_lista()
        self.listbox.delete(0, tk.END)
        self._datos_actuales = []

    def get(self):
        return self.entry.get().strip()

    def set(self, valor):
        self.entry.delete(0, tk.END)
        self.entry.insert(0, str(valor or ""))

    def clear(self):
        self.entry.delete(0, tk.END)
        self._datos_actuales = []
        self._ocultar_lista()
