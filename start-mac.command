#!/bin/bash
cd "$(dirname "$0")"

echo "========================================="
echo "  加油站儲值管理系統 - 啟動程式"
echo "========================================="
echo ""

if ! command -v node &> /dev/null; then
  echo "[錯誤] 找不到 Node.js。"
  echo "請先到 https://nodejs.org 下載安裝「LTS 版本」，"
  echo "安裝完成後，重新雙擊這個檔案即可。"
  echo ""
  read -p "按 Enter 鍵結束"
  exit 1
fi

echo "Node.js 已安裝，正在安裝套件（第一次執行約需 30 秒~1 分鐘）..."
echo ""
npm install
if [ $? -ne 0 ]; then
  echo ""
  echo "[錯誤] 套件安裝失敗，請將上方錯誤訊息截圖回報。"
  read -p "按 Enter 鍵結束"
  exit 1
fi

echo ""
echo "套件安裝完成，正在啟動伺服器..."
echo "瀏覽器將會自動開啟，若沒有自動開啟，請手動輸入：http://localhost:3000/"
echo ""
echo "若要關閉系統，回到這個視窗按 Ctrl + C 即可。"
echo ""

( sleep 2 && open http://localhost:3000/ ) &
npm start
