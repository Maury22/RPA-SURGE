@echo off
echo ============================================
echo   PUBLICAR ACTUALIZACION - Robot SSSalud
echo ============================================
echo.

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
echo [1/3] Actualizando version en package.json...
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json')); p.version='%NEW_VERSION%'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2));"
if errorlevel 1 ( echo [ERROR] Fallo al actualizar package.json & pause & exit /b 1 )

echo [2/3] Commiteando y pusheando a GitHub...
git add .
git commit -m "chore: bump version to %NEW_VERSION%"
git push
if errorlevel 1 ( echo [ERROR] Fallo el git push & pause & exit /b 1 )

echo [3/3] Listo! GitHub Actions esta buildeando el instalador en la nube.
echo.
echo  Podes ver el progreso en:
echo  https://github.com/Maury22/rpa-surge/actions
echo.
echo  En unos minutos el release va a aparecer en:
echo  https://github.com/Maury22/rpa-surge/releases
echo.
echo  Tus companeros recibiran la actualizacion automaticamente.
echo ============================================
echo.
pause
