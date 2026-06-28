# UDIM Texture Organizer

App local para organizar, reordenar, renombrar y exportar texturas UDIM por canal.

## Funciones iniciales

- Importar multiples texturas por canal.
- Detectar UDIM desde nombres como `1001`, `1002`, `1011`.
- Editar UDIM y canal por tile.
- Reordenar tiles con drag and drop.
- Definir base name y patron de renombrado por canal.
- Validar UDIM repetidos, tiles faltantes, nombres finales repetidos, extensiones invalidas y normales en canal incorrecto.
- Exportar ZIP sin recomprimir archivos, cambiando solo el nombre de cada entrada.
- Preview 3D con FBX y aplicacion inicial de tile `1001`.

## Comandos

```bash
pnpm install
pnpm dev
pnpm build
```

## GitHub Pages

El proyecto esta preparado para publicarse de dos formas.

Opcion recomendada si quieres que GitHub lea una carpeta estatica:

1. Sube el repo a GitHub.
2. En `Settings > Pages`, selecciona `Deploy from a branch`.
3. Usa branch `main` y carpeta `/docs`.
4. La carpeta `docs/` contiene el build listo para publicar.

Opcion con GitHub Actions:

1. En `Settings > Pages`, selecciona `GitHub Actions` como source.
2. Haz push a `main`.
3. El workflow `Deploy GitHub Pages` compila la app y publica `dist`.
