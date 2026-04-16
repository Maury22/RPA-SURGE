@echo off
echo ============================================
echo   PUBLICAR ACTUALIZACION - Robot SSSalud
echo ============================================
echo.

if "%GH_TOKEN%"=="" (
    echo [ERROR] No se encontro la variable GH_TOKEN.
    echo.
    echo  Configura el token una sola vez:
    echo  1. Ve a: https://github.com/settings/tokens
    echo  2. Generate new token (classic^), permiso "repo"
    echo  3. En la terminal ejecuta:
    echo     setx GH_TOKEN "tu_token_aqui"
    echo  4. Cierra y vuelve a abrir la terminal.
    echo.
    pause
    exit /b 1
)

for /f %%i in ('node -e "process.stdout.write(require('./package.json').version)"') do set CURRENT_VERSION=%%i
echo Version actual: %CURRENT_VERSION%
echo.
set /p NEW_VERSION="Nueva version (ej: 1.0.1): "

if "%NEW_VERSION%"=="" (
    echo [ERROR] Version vacia. Cancelado.
    pause
    exit /b 1
)

echo.
echo [1/4] Actualizando version en package.json...
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json')); p.version='%NEW_VERSION%'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2));"
if errorlevel 1 ( echo [ERROR] Fallo al actualizar package.json & pause & exit /b 1 )

echo [2/4] Commiteando cambios en git...
git add .
git commit -m "chore: bump version to %NEW_VERSION%"
git push
if errorlevel 1 ( echo [ERROR] Fallo el git push & pause & exit /b 1 )

echo [3/4] Buildeando instalador y publicando en GitHub Releases...
echo       (Puede tardar varios minutos...)
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set WIN_CSC_KEY_PASSWORD=
npx electron-builder --win --publish always -c.win.certificateFile="" -c.forceCodeSigning=false
if errorlevel 1 ( echo [ERROR] Fallo el build/publicacion & pause & exit /b 1 )

echo.
echo ============================================
echo  LISTO! Version %NEW_VERSION% publicada.
echo  Tus companeros recibiran la actualizacion
echo  automaticamente al abrir la app.
echo ============================================
echo.
pause
