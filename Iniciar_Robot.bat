@echo off
echo ===========================================
echo Iniciando el Robot Facturador...
echo Por favor, no cierres esta ventana negra.
echo ===========================================

REM Configurar entorno para la red de la oficina
set NODE_TLS_REJECT_UNAUTHORIZED=0

REM Abrir Google Chrome en la página de nuestro Robot
start http://localhost:3000

REM Arrancar el servidor web
node server.js

pause