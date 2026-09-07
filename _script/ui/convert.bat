@echo off
cls
for /r %%i in (*.pdf) do (
  echo %%i
  magick -density 50 "%%i" -quality 50 -background white ^
    -alpha remove -alpha off "%%~dpni-%%02d.jpg" && del "%%i"
)