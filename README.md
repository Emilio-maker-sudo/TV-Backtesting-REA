# TV Backtester 2.0 — Bar Replay gratis para TradingView

## Cómo funciona (por qué no es un overlay)
TradingView recibe las velas por WebSocket (`timescale_update` / `du`). `hook.js` reemplaza `WebSocket`
antes de que cargue TradingView y `engine.js` filtra ese flujo: **las velas futuras nunca llegan al gráfico**.
- El motor guarda **todas** las velas que manda el servidor en un store local (`ser.full`), que se conserva
  aunque el gráfico recargue el mismo timeframe.
- **Cortar / retroceder / cambiar TF**: en vez de depender de lo que el servidor reenvíe (que solo cubre el rango
  visible y deja el timescale desalineado), el motor limpia el gráfico y le inyecta un `timescale_update` **completo
  y sintético** (`index=0`) armado desde el store local, con exactamente las velas visibles hasta `T`. Así el futuro
  se elimina de verdad y el gráfico queda siempre alineado desde la primera vela.
- Avanzar N velas = inyectar solo las N velas nuevas (delta).
- Timeframes: el corte es un instante (`T`), no un índice. Una vela de TF mayor que aún no cerró a `T` se reconstruye
  solo con velas menores anteriores a `T` (nunca se ve el cierre/máximo/mínimo del futuro).
- Indicadores: las filas de datos se filtran igual. Los **dibujos de Pine** (labels, cajas, tablas, trades de estrategias)
  pueden contener futuro, así que el *modo estricto* (activado por defecto) los oculta mientras dura el backtest.

## Estructura
```
src/core/protocol.js  framing ~m~ y resoluciones
src/core/engine.js    store, reloj T, filtro, pasos, inyección
src/core/hook.js      parche de WebSocket (entrante, saliente, inyección)
src/core/tvapi.js     TradingViewApi: crosshair, recarga
src/ui/ui.js|css      botón, tijera, panel
src/main.js           window.__tvbt (diag, cutAt, step, exit)
tests/                simulación servidor/cliente TV + jsdom   (npm i && npm test)
```

## Si algo no anda
En la consola de TradingView: `__tvbt.diag()` y pasame la salida. Dice si el hook vio el WebSocket,
qué series hay, y qué partes de la API del gráfico existen.

## Limitaciones conocidas
- Un solo gráfico (no multi-layout) por ahora.
- El contador regresivo de cierre de vela de TradingView muestra el de la vela real.
- Depende del protocolo interno de TradingView; si lo cambian, hay que ajustar `engine.js`.
