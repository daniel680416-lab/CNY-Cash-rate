@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo ==================================================
echo   CNY Cash Rate Tracker - 本地爬蟲更新工具
echo ==================================================
echo.

:: 請在此處填入您的 MongoDB Atlas 連線字串 (MONGODB_URI)
:: 例如: set MONGODB_URI=mongodb+srv://daniel680416_db_user:SaTKjt06r6Myo1B7@cluster0.xxxx.mongodb.net/exchange_rates?retryWrites=true^&w=majority
:: 注意: 連線字串中的 & 符號在批次檔中必須寫成 ^& 進行轉義
set MONGODB_URI=您的_MONGODB_URI_連線字串

if "%MONGODB_URI%"=="您的_MONGODB_URI_連線字串" (
    echo [錯誤] 請先編輯此批次檔，將 "您的_MONGODB_URI_連線字串" 替換為您真實的 MongoDB Atlas 連線網址！
    echo.
    pause
    exit /b 1
)

echo [1/3] 正在執行爬蟲並同步至資料庫與導出 data.json...
node scraper.js
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [失敗] 爬蟲執行過程中出錯，更新已中斷。
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] 正在將最新的 data.json 與日誌提交至 GitHub...
git add data.json scraper.log
git commit -m "Data: update exchange rates from local machine [skip ci]"
if %ERRORLEVEL% NEQ 0 (
    echo [提示] 沒有新的匯率變動或無需提交。
)

echo.
echo [3/3] 正在推送至 GitHub 觸發網頁部署...
git push origin main
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [失敗] 推送至 GitHub 失敗，請確認您的 Git 權限與網路連線。
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ==================================================
echo   🎉 更新成功！GitHub Pages 網頁將在 1 分鐘內更新。
echo ==================================================
echo.
pause
