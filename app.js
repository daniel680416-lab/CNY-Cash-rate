// ==========================================
// CNY Cash Rate PWA Frontend Application
// ==========================================

// --- MOCK DATA (Fallback if network is down and cache is empty) ---
const MOCK_HISTORICAL_DATA = [
  { date: "2026-07-13", buy_rate: 4.385, sell_rate: 4.547, average_rate: 4.47, timestamp: 1783922400000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-12", buy_rate: 4.380, sell_rate: 4.542, average_rate: 4.46, timestamp: 1783836000000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-11", buy_rate: 4.380, sell_rate: 4.542, average_rate: 4.46, timestamp: 1783749600000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-10", buy_rate: 4.380, sell_rate: 4.542, average_rate: 4.46, timestamp: 1783663200000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-09", buy_rate: 4.392, sell_rate: 4.554, average_rate: 4.47, timestamp: 1783576800000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-08", buy_rate: 4.395, sell_rate: 4.559, average_rate: 4.48, timestamp: 1783490400000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-07", buy_rate: 4.402, sell_rate: 4.566, average_rate: 4.48, timestamp: 1783404000000, last_updated_time: "16:18", source: "bot" },
  { date: "2026-07-06", buy_rate: 4.390, sell_rate: 4.552, average_rate: 4.47, timestamp: 1783317600000, last_updated_time: "16:18", source: "bot" }
];

// --- CONFIGURATION ---
// 貼上您的 Cloudflare Worker 網址以實現前端即時同步 (例: 'https://cny-worker.xxxx.workers.dev')
const CLOUDFLARE_WORKER_URL = 'https://scratch.daniel680416.workers.dev/'; 

// --- APP STATE ---
let currentRates = []; // Loaded exchange rate data (Sorted by date desc)
let mainChartInstance = null;
let sparklineChartInstance = null;
let activeCalcMode = 'sell'; // 'buy', 'sell', 'avg'
let alertSettings = { low: null, high: null };

// --- INDEXED DB HELPER ---
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('CNYRateTrackerDB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('rates')) {
        db.createObjectStore('rates', { keyPath: 'date' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function getCachedRates() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rates', 'readonly');
      const store = tx.objectStore('rates');
      const req = store.getAll();
      req.onsuccess = () => {
        const sorted = req.result.sort((a, b) => b.timestamp - a.timestamp);
        resolve(sorted);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error('讀取 IndexedDB 快取失敗:', error);
    return [];
  }
}

async function cacheRates(ratesArray) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rates', 'readwrite');
      const store = tx.objectStore('rates');
      ratesArray.forEach(rate => store.put(rate));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error('寫入 IndexedDB 快取失敗:', error);
  }
}

async function clearIndexedDBCache() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rates', 'readwrite');
      const store = tx.objectStore('rates');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error('清除 IndexedDB 快取失敗:', error);
  }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  // 註冊 PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('Service Worker 註冊成功，範圍:', reg.scope))
        .catch(err => console.error('Service Worker 註冊失敗:', err));
    });
  }

  // Initialize Lucide Icons
  lucide.createIcons();

  // Load Settings from LocalStorage
  loadSettings();

  // Setup Event Listeners
  setupNavigation();
  setupTheme();
  setupNetworkMonitoring();
  setupSettingsHandlers();
  setupCalculator();
  setupPwaInstall();

  // Load Data
  refreshData();
});

// --- DATA FETCHING ---
function loadSettings() {
  const savedAlertSettings = localStorage.getItem('cny_tracker_alert_settings');
  if (savedAlertSettings) {
    alertSettings = JSON.parse(savedAlertSettings);
    document.getElementById('alert-low').value = alertSettings.low || '';
    document.getElementById('alert-high').value = alertSettings.high || '';
  }
}

async function refreshData() {
  const isOnline = navigator.onLine;
  let fetchedData = [];

  if (isOnline) {
    const tbody = document.getElementById('historyTableBody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">正在下載最新匯率數據...</td></tr>';
    }
    try {
      fetchedData = await fetchRatesData();
      if (fetchedData && fetchedData.length > 0) {
        // 補充今日即時數據（若伺服器 Actions 尚未執行）
        fetchedData = await supplementTodayRateIfMissing(fetchedData);
        // Cache to IndexedDB
        await cacheRates(fetchedData);
      }
    } catch (error) {
      console.error('下載最新匯率數據失敗，降級使用本地快取:', error);
      fetchedData = await getCachedRates();
      // 嘗試從本地快取補充今日數據
      fetchedData = await supplementTodayRateIfMissing(fetchedData);
    }
  } else {
    // Offline: check IndexedDB
    fetchedData = await getCachedRates();
  }

  // If both server and cache are empty, fallback to Mock Data
  if (fetchedData.length === 0) {
    console.log('快取與伺服器均無資料，載入模擬測試數據。');
    fetchedData = MOCK_HISTORICAL_DATA;
    await cacheRates(MOCK_HISTORICAL_DATA);
  }

  // Set App State
  currentRates = fetchedData;

  // Render UI
  updateDashboardUI();
  renderSparkline();
  updateCalculatorUI();
  updateHistoryTable();
  
  // Render main chart if active tab is trends
  const activeTab = document.querySelector('.nav-item.active').getAttribute('data-tab');
  if (activeTab === 'trends') {
    renderMainTrendChart(7);
  }
}

// 輔助函式：若 Actions 未跑完，前端直接向 FinMind 補充今日匯率
async function supplementTodayRateIfMissing(data) {
  if (!data || data.length === 0) return data;

  // 取得台北時間今天的日期 (YYYY-MM-DD)
  const todayStr = new Date().toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');

  const latestRecordDate = data[0].date;
  const latestRecordSource = data[0].source;

  // 如果伺服器最新一筆日期不是今天，或者雖然日期是今天但不是 100% 同步的官方來源（如 finmind），則嘗試從前端獲取今日即時官方數據
  const needsSync = latestRecordDate !== todayStr || (latestRecordSource !== 'bot' && latestRecordSource !== 'bot_live');

  if (needsSync) {
    console.log(`[CNY Tracker] 最新日期為 ${latestRecordDate} (來源: ${latestRecordSource})，今日 (${todayStr}) 尚未完成台銀官方同步，嘗試獲取即時數據...`);

    // 1. 優先嘗試透過 Cloudflare Worker 獲取台銀官方實時匯率
    if (typeof CLOUDFLARE_WORKER_URL === 'string' && CLOUDFLARE_WORKER_URL.trim() !== '') {
      try {
        console.log('[CNY Tracker] 嘗試透過 Cloudflare Worker 獲取今日即時匯率...');
        const res = await fetch(CLOUDFLARE_WORKER_URL);
        if (res.ok) {
          const todayRecord = await res.json();
          if (todayRecord && todayRecord.date === todayStr && todayRecord.buy_rate && todayRecord.sell_rate) {
            console.log('[CNY Tracker] 🎉 成功透過 Cloudflare Worker 獲取今日即時官方匯率！', todayRecord);
            
            // 如果最新一筆日期就是今天，但來源是 finmind，我們用今日即時官方紀錄覆蓋/取代它
            if (latestRecordDate === todayStr) {
              const updatedData = [...data];
              updatedData[0] = todayRecord;
              return updatedData;
            } else {
              return [todayRecord, ...data];
            }
          }
        }
      } catch (err) {
        console.warn('[CNY Tracker] 透過 Cloudflare Worker 獲取即時數據失敗:', err.message);
      }
    }

    // 2. 降級嘗試直連 FinMind API 獲取 (僅在今日完全無任何紀錄時才執行)
    if (latestRecordDate !== todayStr) {
      try {
        const pastDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const finmindUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanExchangeRate&data_id=CNY&start_date=${pastDate}`;
        
        const res = await fetch(finmindUrl);
        if (res.ok) {
          const result = await res.json();
          if (result && result.data && result.data.length > 0) {
            const latest = result.data[result.data.length - 1];
            if (latest.date === todayStr) {
              const buyRate = parseFloat(latest.cash_buy);
              const sellRate = parseFloat(latest.cash_sell);
              if (!isNaN(buyRate) && !isNaN(sellRate)) {
                const avgRate = Math.round(((buyRate + sellRate) / 2) * 100) / 100;
                const todayRecord = {
                  date: todayStr,
                  buy_rate: buyRate,
                  sell_rate: sellRate,
                  average_rate: avgRate,
                  timestamp: Date.now(),
                  last_updated_time: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }),
                  source: 'finmind_live'
                };
                console.log('[CNY Tracker] 🎉 成功從備用 API (FinMind) 獲取今日即時匯率！並入列表:', todayRecord);
                return [todayRecord, ...data];
              }
            }
          }
        }
      } catch (err) {
        console.warn('[CNY Tracker] 從備用 API (FinMind) 獲取今日數據失敗:', err.message);
      }
    }
  }
  return data;
}

// Fetch data.json from server
async function fetchRatesData() {
  // Append timestamp query parameter to prevent browser caching
  const response = await fetch(`./data.json?t=${new Date().getTime()}`);
  if (!response.ok) {
    throw new Error(`無法獲取匯率數據, 狀態碼: ${response.status}`);
  }
  return await response.json();
}

// --- UI UPDATES ---
function updateDashboardUI() {
  if (currentRates.length === 0) return;

  const today = currentRates[0];
  const yesterday = currentRates.length > 1 ? currentRates[1] : null;

  // Set Rate values
  document.getElementById('buyRateValue').textContent = today.buy_rate.toFixed(3);
  document.getElementById('sellRateValue').textContent = today.sell_rate.toFixed(3);
  document.getElementById('avgRateValue').textContent = today.average_rate.toFixed(2);
  
  let sourceLabel = '';
  if (today.source === 'bot') {
    sourceLabel = '台銀官方牌告 (100% 同步)';
  } else if (today.source === 'finmind') {
    sourceLabel = '備用資料源 (FinMind)';
  } else if (today.source === 'finmind_live') {
    sourceLabel = '前端即時同步 (備用)';
  } else {
    sourceLabel = '台銀牌告匯率';
  }
  document.getElementById('lastUpdatedTime').textContent = `最後更新時間：${today.date} ${today.last_updated_time} (${sourceLabel})`;

  // Update trend indicators
  updateTrendIndicator('buyRateChange', today.buy_rate, yesterday ? yesterday.buy_rate : null);
  updateTrendIndicator('sellRateChange', today.sell_rate, yesterday ? yesterday.sell_rate : null);
  updateTrendIndicator('avgRateChange', today.average_rate, yesterday ? yesterday.average_rate : null);

  // Check alerts threshold
  checkAlertThreshold(today.average_rate);
}

function updateTrendIndicator(elementId, todayVal, yesterdayVal) {
  const el = document.getElementById(elementId);
  if (!yesterdayVal) {
    el.textContent = '0.00%';
    el.className = 'change-label neutral';
    return;
  }

  const diff = todayVal - yesterdayVal;
  const pct = ((diff / yesterdayVal) * 100).toFixed(2);
  const prefix = diff > 0 ? '+' : '';

  el.textContent = `${prefix}${pct}%`;
  
  if (diff > 0) {
    el.className = 'change-label up';
  } else if (diff < 0) {
    el.className = 'change-label down';
  } else {
    el.className = 'change-label neutral';
  }
}

function checkAlertThreshold(avgRate) {
  const alertBanner = document.getElementById('thresholdAlertBanner');
  const alertText = document.getElementById('thresholdAlertText');
  
  let showAlert = false;
  let textMsg = '';

  if (alertSettings.low && avgRate <= alertSettings.low) {
    showAlert = true;
    textMsg = `【買點提示】當前平均匯率 (${avgRate.toFixed(2)}) 已低於您設定的下限值 (${parseFloat(alertSettings.low).toFixed(2)})，是合適的買入點！`;
  } else if (alertSettings.high && avgRate >= alertSettings.high) {
    showAlert = true;
    textMsg = `【賣點提示】當前平均匯率 (${avgRate.toFixed(2)}) 已高於您設定的上限值 (${parseFloat(alertSettings.high).toFixed(2)})，是合適的結匯/賣出點！`;
  }

  if (showAlert) {
    alertText.textContent = textMsg;
    alertBanner.classList.remove('hidden');
  } else {
    alertBanner.classList.add('hidden');
  }
}

// Render sparkline on Dashboard
function renderSparkline() {
  const canvas = document.getElementById('sparklineChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (sparklineChartInstance) sparklineChartInstance.destroy();

  // Get last 7 days (reverse for chronological order)
  const last7Data = [...currentRates].slice(0, 7).reverse();
  if (last7Data.length === 0) return;

  const labels = last7Data.map(d => d.date.substring(5)); // MM-DD
  const averages = last7Data.map(d => d.average_rate);

  sparklineChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        data: averages,
        borderColor: '#8b5cf6',
        borderWidth: 2,
        fill: true,
        backgroundColor: 'rgba(139, 92, 246, 0.05)',
        tension: 0.4,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { display: false },
        y: { display: false }
      }
    }
  });
}

// Render Main Trend Chart
function renderMainTrendChart(daysRange) {
  const canvas = document.getElementById('mainTrendChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (mainChartInstance) mainChartInstance.destroy();

  // Filter based on range
  const chartData = [...currentRates].slice(0, daysRange).reverse();
  if (chartData.length === 0) return;

  const labels = chartData.map(d => d.date);
  const buyRates = chartData.map(d => d.buy_rate);
  const sellRates = chartData.map(d => d.sell_rate);
  const avgRates = chartData.map(d => d.average_rate);

  const isLight = document.body.classList.contains('light-mode');
  const gridColor = isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.05)';
  const textColor = isLight ? '#475569' : '#94a3b8';

  mainChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '現金買進',
          data: buyRates,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.05)',
          borderWidth: 2,
          tension: 0.35,
          pointBackgroundColor: '#10b981',
          pointRadius: 3,
          pointHoverRadius: 6
        },
        {
          label: '現金賣出',
          data: sellRates,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.05)',
          borderWidth: 2,
          tension: 0.35,
          pointBackgroundColor: '#f59e0b',
          pointRadius: 3,
          pointHoverRadius: 6
        },
        {
          label: '平均匯率',
          data: avgRates,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.05)',
          borderWidth: 3,
          tension: 0.35,
          pointBackgroundColor: '#8b5cf6',
          pointRadius: 4,
          pointHoverRadius: 7,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          padding: 12,
          backgroundColor: isLight ? '#ffffff' : '#1e293b',
          titleColor: isLight ? '#0f172a' : '#f8fafc',
          bodyColor: isLight ? '#475569' : '#94a3b8',
          borderColor: 'rgba(99, 102, 241, 0.1)',
          borderWidth: 1,
          boxPadding: 6,
          titleFont: { family: 'Outfit', weight: 'bold' },
          bodyFont: { family: 'Inter' }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'Inter', size: 10 } }
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'Inter', size: 10 } }
        }
      }
    }
  });
}

// Update History Table
function updateHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  if (currentRates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-loading">暫無資料</td></tr>';
    return;
  }

  let html = '';
  currentRates.forEach(r => {
    const badgeClass = r.source === 'manual' ? 'badge-manual' : 'badge-bot';
    const badgeText = r.source === 'manual' ? '手動' : '台銀自動';
    
    html += `
      <tr>
        <td style="font-family: var(--font-display); font-weight: 600;">${r.date}</td>
        <td style="font-family: var(--font-display); color: var(--color-buy); font-weight: 500;">${r.buy_rate.toFixed(3)}</td>
        <td style="font-family: var(--font-display); color: var(--color-sell); font-weight: 500;">${r.sell_rate.toFixed(3)}</td>
        <td style="font-family: var(--font-display); color: var(--color-avg); font-weight: 700;">${r.average_rate.toFixed(2)}</td>
        <td>${r.last_updated_time}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// --- CALCULATOR LOGIC ---
function setupCalculator() {
  const cnyInput = document.getElementById('calc-cny-input');
  const twdInput = document.getElementById('calc-twd-input');
  if (!cnyInput || !twdInput) return;
  
  const tabs = {
    buy: document.getElementById('calc-buy-tab'),
    sell: document.getElementById('calc-sell-tab'),
    avg: document.getElementById('calc-avg-tab')
  };

  // Switch Calculator rate tabs
  Object.keys(tabs).forEach(mode => {
    const tabEl = tabs[mode];
    if (!tabEl) return;
    tabEl.addEventListener('click', () => {
      Object.values(tabs).forEach(btn => btn && btn.classList.remove('active'));
      tabEl.classList.add('active');
      activeCalcMode = mode;
      updateCalculatorUI();
      // Recalculate based on current CNY input
      convertCurrency('cny');
    });
  });

  cnyInput.addEventListener('input', () => convertCurrency('cny'));
  twdInput.addEventListener('input', () => convertCurrency('twd'));
}

function updateCalculatorUI() {
  if (currentRates.length === 0) return;
  const rateInfo = document.getElementById('calc-rate-info');
  if (!rateInfo) return;
  
  const rate = getActiveCalculatorRate();

  let labelText = '';
  if (activeCalcMode === 'buy') {
    labelText = `現金買進價 (回台幣)：1 CNY = ${rate.toFixed(3)} TWD`;
  } else if (activeCalcMode === 'sell') {
    labelText = `現金賣出價 (換外幣)：1 CNY = ${rate.toFixed(3)} TWD`;
  } else {
    labelText = `平均參考價 (四捨五入)：1 CNY = ${rate.toFixed(2)} TWD`;
  }

  rateInfo.textContent = labelText;
}

function getActiveCalculatorRate() {
  if (currentRates.length === 0) return 1.0;
  const today = currentRates[0];
  if (activeCalcMode === 'buy') return today.buy_rate;
  if (activeCalcMode === 'sell') return today.sell_rate;
  return today.average_rate;
}

function convertCurrency(source) {
  const cnyInput = document.getElementById('calc-cny-input');
  const twdInput = document.getElementById('calc-twd-input');
  if (!cnyInput || !twdInput) return;
  
  const rate = getActiveCalculatorRate();

  if (source === 'cny') {
    const val = parseFloat(cnyInput.value);
    if (isNaN(val)) {
      twdInput.value = '';
    } else {
      twdInput.value = (val * rate).toFixed(2);
    }
  } else {
    const val = parseFloat(twdInput.value);
    if (isNaN(val)) {
      cnyInput.value = '';
    } else {
      cnyInput.value = (val / rate).toFixed(2);
    }
  }
}

// --- SETTINGS LOGIC ---
function setupSettingsHandlers() {
  const saveAlertBtn = document.getElementById('saveAlertBtn');
  const clearAlertBtn = document.getElementById('clearAlertBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const loadMockBtn = document.getElementById('loadMockBtn');

  if (saveAlertBtn) {
    saveAlertBtn.addEventListener('click', () => {
      const low = document.getElementById('alert-low').value;
      const high = document.getElementById('alert-high').value;
      
      alertSettings = {
        low: low ? parseFloat(low) : null,
        high: high ? parseFloat(high) : null
      };

      localStorage.setItem('cny_tracker_alert_settings', JSON.stringify(alertSettings));
      alert('警示閥值已更新！');
      if (currentRates.length > 0) {
        checkAlertThreshold(currentRates[0].average_rate);
      }
    });
  }

  if (clearAlertBtn) {
    clearAlertBtn.addEventListener('click', () => {
      document.getElementById('alert-low').value = '';
      document.getElementById('alert-high').value = '';
      alertSettings = { low: null, high: null };
      localStorage.removeItem('cny_tracker_alert_settings');
      document.getElementById('thresholdAlertBanner').classList.add('hidden');
      alert('已清除所有警示設定！');
    });
  }

  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      if (!navigator.onLine) {
        alert('您目前處於離線狀態，請先連線網路後再重新同步資料！');
        return;
      }
      
      if (confirm('確定要清除本地快取並重新與伺服器同步資料嗎？')) {
        await clearIndexedDBCache();
        await refreshData();
        alert('🎉 資料同步完成！已成功從伺服器載入最新數據。');
      }
    });
  }

  if (loadMockBtn) {
    loadMockBtn.addEventListener('click', async () => {
      if (confirm('確定要載入測試用模擬數據嗎？這將會覆寫目前的快取資料。')) {
        await clearIndexedDBCache();
        await cacheRates(MOCK_HISTORICAL_DATA);
        alert('已載入內建模擬數據！');
        await refreshData();
      }
    });
  }

  // Export Data Buttons
  const csvBtn = document.getElementById('exportCsvBtn');
  const jsonBtn = document.getElementById('exportJsonBtn');
  if (csvBtn) csvBtn.addEventListener('click', exportToCSV);
  if (jsonBtn) jsonBtn.addEventListener('click', exportToJSON);
}

function exportToCSV() {
  if (currentRates.length === 0) return;
  
  let csvContent = 'data:text/csv;charset=utf-8,';
  csvContent += '日期,現金買進(TWD),現金賣出(TWD),平均匯率,更新時間,來源\n';
  
  currentRates.forEach(r => {
    csvContent += `${r.date},${r.buy_rate},${r.sell_rate},${r.average_rate},${r.last_updated_time},${r.source}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `cny_cash_rates_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportToJSON() {
  if (currentRates.length === 0) return;

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(currentRates, null, 2));
  const link = document.createElement('a');
  link.setAttribute('href', dataStr);
  link.setAttribute('download', `cny_cash_rates_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- THEME SWITCHING ---
function setupTheme() {
  const toggleBtn = document.getElementById('themeToggle');
  if (!toggleBtn) return;
  
  // Set system dark mode preference or cached preference
  const cachedTheme = localStorage.getItem('cny_tracker_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  if (cachedTheme === 'light') {
    document.body.classList.add('light-mode');
  } else if (cachedTheme === 'dark' || prefersDark) {
    document.body.classList.remove('light-mode');
  } else {
    document.body.classList.remove('light-mode'); // Default is dark
  }

  toggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    const isLight = document.body.classList.contains('light-mode');
    localStorage.setItem('cny_tracker_theme', isLight ? 'light' : 'dark');
    
    // Refresh main chart colors if active
    const activeTab = document.querySelector('.nav-item.active').getAttribute('data-tab');
    if (activeTab === 'trends' && currentRates.length > 0) {
      const activeRange = document.querySelector('.chart-controls .active').getAttribute('data-range');
      renderMainTrendChart(parseInt(activeRange));
    }
  });
}

// --- NAVIGATION & TABS ---
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.tab-panel');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      // Remove active from nav and panels
      navItems.forEach(n => n.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      // Set active
      item.classList.add('active');
      const tabName = item.getAttribute('data-tab');
      document.getElementById(`panel-${tabName}`).classList.add('active');

      // Hook tab-specific activations
      if (tabName === 'trends') {
        setTimeout(() => renderMainTrendChart(7), 50); // Small timeout to ensure DOM layout is ready
      }
    });
  });

  // Trend range toggle controls
  const rangeButtons = document.querySelectorAll('.chart-controls button');
  rangeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      rangeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const days = parseInt(btn.getAttribute('data-range'));
      renderMainTrendChart(days);
    });
  });
}

// --- NETWORK MONITORING ---
function setupNetworkMonitoring() {
  const statusIndicator = document.getElementById('networkStatus');
  if (!statusIndicator) return;
  const dot = statusIndicator.querySelector('.status-dot');
  const text = statusIndicator.querySelector('.status-text');

  function updateStatus() {
    const isOnline = navigator.onLine;
    if (isOnline) {
      dot.className = 'status-dot online';
      text.textContent = '在線';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = '離線';
    }
  }

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

// --- PWA INSTALLATION PROMPT ---
let deferredInstallPrompt = null;

function setupPwaInstall() {
  const installBox = document.getElementById('installPromptBox');
  const installBtn = document.getElementById('installBtn');
  if (!installBox || !installBtn) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBox.style.display = 'flex';
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log(`PWA 安裝選擇結果: ${outcome}`);
    deferredInstallPrompt = null;
    installBox.style.display = 'none';
  });

  window.addEventListener('appinstalled', () => {
    console.log('CNY 匯率追蹤 PWA 已成功安裝至系統。');
    installBox.style.display = 'none';
  });
}
