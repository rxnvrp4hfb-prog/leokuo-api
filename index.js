const CPBL_PUBLIC = "https://www.cpbl.com.tw";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const REMINDERS_KEY = "reminders";

function browserHeaders({ ajax = false, referer = `${CPBL_PUBLIC}/`, includeOrigin = false } = {}) {
  return {
    "User-Agent": UA,
    "Accept": ajax ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": referer,
    ...(includeOrigin ? { "Origin": CPBL_PUBLIC } : {}),
    ...(ajax ? {
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    } : {
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Upgrade-Insecure-Requests": "1",
    }),
  };
}

function cookieNames(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((x) => x.trim().split("=")[0])
    .filter(Boolean);
}

const TEAM_COLORS = {
  AAA011: "#c8102e",
  AEO011: "#004b9b",
  AKP011: "#0b5f4a",
  ADD011: "#f97316",
  AJL011: "#8a1538",
  ACN011: "#facc15",
};

const FIELD_NAMES = {
  F01: "台北大巨蛋",
  F02: "新莊",
  F03: "桃園",
  F04: "台中洲際",
  F05: "台南",
  F06: "澄清湖",
  F07: "嘉義市",
  F08: "斗六",
  F09: "亞太主",
  F10: "花蓮",
  F11: "天母",
};

function jsonResponse(obj, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "https://baseball.leokuo.com",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    },
  });
}

function nowText() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function parseJsonMaybe(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function inputValue(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `name=["']${esc}["'][^>]*value=["']([^"']*)["']|value=["']([^"']*)["'][^>]*name=["']${esc}["']`,
    "i",
  );
  const m = String(html || "").match(re);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

function cookiesFrom(response) {
  let values = [];
  if (typeof response.headers.getSetCookie === "function") {
    values = response.headers.getSetCookie();
  } else {
    const raw = response.headers.get("set-cookie") || "";
    if (raw) values = raw.split(/,(?=[^;,]+=)/);
  }
  return values
    .map((x) => String(x).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(...cookieStrings) {
  const jar = new Map();
  for (const cookieString of cookieStrings) {
    for (const item of String(cookieString || "").split(";")) {
      const cookie = item.trim();
      const eq = cookie.indexOf("=");
      if (eq > 0) jar.set(cookie.slice(0, eq), cookie);
    }
  }
  return [...jar.values()].join("; ");
}

async function fetchCpbl(path, init = {}) {
  return fetch(`${CPBL_PUBLIC}${path}`, {
    ...init,
    headers: init.headers || {},
    redirect: init.redirect || "follow",
  });
}

function proxyBaseUrl(env) {
  return String(env?.CPBL_PROXY_BASE_URL || "").replace(/\/+$/, "");
}

async function postCpblViaProxy(env, path, payload) {
  const baseUrl = proxyBaseUrl(env);
  if (!baseUrl) throw new Error("CPBL proxy 尚未設定");
  const response = await fetch(`${baseUrl}/cpbl`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(env?.CPBL_PROXY_TOKEN ? { Authorization: `Bearer ${env.CPBL_PROXY_TOKEN}` } : {}),
    },
    body: JSON.stringify({ path, payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `CPBL proxy 回應 ${response.status}`);
  return data.data;
}

async function cpblSession() {
  let token = "";
  let cookie = "";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetchCpbl("/", {
      redirect: "manual",
      headers: browserHeaders(),
    });

    lastStatus = response.status;
    const html = await response.text();

    if (!response.ok) {
      if (attempt === 2) throw new Error(`CPBL 首頁回應 ${response.status}`);
      continue;
    }

    token = inputValue(html, "__RequestVerificationToken") || token;
    cookie = mergeCookies(cookie, cookiesFrom(response));

    if (token) break;
  }

  if (!token) {
    throw new Error(`找不到 CPBL 驗證 token（最後首頁狀態 ${lastStatus || "unknown"}）`);
  }

  return { token, cookie };
}

async function postCpbl(env, path, payload) {
  if (proxyBaseUrl(env)) return postCpblViaProxy(env, path, payload);

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const session = await cpblSession();
      const body = new URLSearchParams({
        __RequestVerificationToken: session.token,
        ...payload,
      });

      const response = await fetchCpbl(path, {
        method: "POST",
        redirect: "manual",
        body,
        headers: {
          ...browserHeaders({
            ajax: true,
            referer: `${CPBL_PUBLIC}/`,
            includeOrigin: true,
          }),
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          ...(session.cookie ? { Cookie: session.cookie } : {}),
        },
      });

      if (response.ok) {
        return response.json();
      }

      const preview = await response.text().catch(() => "");
      lastError = new Error(
        `CPBL API 回應 ${response.status}${preview ? `：${stripHtml(preview).slice(0, 160)}` : ""}`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("CPBL API 請求失敗");
}

async function postCpblLive(env, year, kindCode, gameSno) {
  if (proxyBaseUrl(env)) {
    return postCpblViaProxy(env, "/box/getlive", {
      GameSno: String(gameSno),
      KindCode: String(kindCode),
      Year: String(year),
    });
  }

  const referer = `${CPBL_PUBLIC}/box/live?year=${year}&kindCode=${kindCode}&gameSno=${gameSno}`;
  const path = `/box/live?year=${year}&kindCode=${kindCode}&gameSno=${gameSno}`;
  const page = await fetchCpbl(path, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" },
  });
  const html = await page.text();
  const payload = {
    __RequestVerificationToken: inputValue(html, "__RequestVerificationToken"),
    GameSno: String(gameSno),
    KindCode: String(kindCode),
    Year: String(year),
    PrevOrNext: inputValue(html, "PrevOrNext") || "0",
  };
  const body = new URLSearchParams(payload);
  let cookie = cookiesFrom(page);
  let response = null;
  for (let i = 0; i < 3; i++) {
    response = await fetchCpbl("/box/getlive", {
      method: "POST",
      redirect: "manual",
      body,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-TW,zh;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: referer,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    cookie = mergeCookies(cookie, cookiesFrom(response));
    if (response.status !== 308 && response.status !== 301 && response.status !== 302 && response.status !== 307) break;
  }
  if (!response?.ok) throw new Error(`CPBL live API 回應 ${response?.status || "unknown"}`);
  return response.json();
}

function inningText(seq, side, statusCode) {
  if (Number(statusCode) === 1) return "尚未開賽";
  if (!seq) return "—";
  const sideText = { V: "▲", H: "▼", 1: "▲", 2: "▼", 客: "▲", 主: "▼" }[String(side)] || "";
  return sideText ? `${seq}局 ${sideText}` : `第${seq}局`;
}

function pauseReasonFrom(...parts) {
  const txt = parts.map((x) => String(x || "")).join(" ");
  if (/更換投手|投手更換|換投|換上投手|投手交代|投手丘.*換/.test(txt)) return "更換投手暫停";
  if (/教練.*暫停|暫停.*教練|教練喊停|教練上投手丘|投手教練/.test(txt)) return "教練暫停";
  if (!/暫停|中斷|保留|裁定|延賽/.test(txt)) return "";
  if (/因雨|雨勢|天候因素|天候|雷雨/.test(txt)) return "天候暫停";
  if (txt.includes("保留")) return "保留比賽";
  if (txt.includes("裁定")) return "裁定比賽";
  if (txt.includes("因故")) return "因故暫停";
  if (txt.includes("中斷")) return "比賽中斷";
  if (txt.includes("暫停")) return "暫停原因確認中";
  return "";
}

function battingStateFromLog(cb = {}) {
  return {
    balls: Number(cb.BallCnt || 0),
    strikes: Number(cb.StrikeCnt || 0),
    outs: Number(cb.OutCnt || 0),
    bases: {
      first: Boolean(cb.FirstBase),
      second: Boolean(cb.SecondBase),
      third: Boolean(cb.ThirdBase),
    },
    baseNames: {
      first: cb.FirstBase || "",
      second: cb.SecondBase || "",
      third: cb.ThirdBase || "",
    },
    pitcher: cb.PitcherName || "",
    hitter: cb.HitterName || "",
  };
}

function battingState(g) {
  let cb = g.CurtBatting || {};
  if (Array.isArray(cb)) cb = cb[0] || {};
  return battingStateFromLog(cb);
}

function fieldName(value) {
  if (!value) return "";
  return FIELD_NAMES[String(value)] || String(value);
}

function teamColor(code, name = "") {
  code = String(code || "");
  if (TEAM_COLORS[code]) return TEAM_COLORS[code];
  if (code.length >= 3 && TEAM_COLORS[`${code.slice(0, 3)}011`]) return TEAM_COLORS[`${code.slice(0, 3)}011`];
  const text = String(name || "");
  const nameMap = [
    ["味全", TEAM_COLORS.AAA011],
    ["富邦", TEAM_COLORS.AEO011],
    ["台鋼", TEAM_COLORS.AKP011],
    ["統一", TEAM_COLORS.ADD011],
    ["樂天", TEAM_COLORS.AJL011],
    ["桃猿", TEAM_COLORS.AJL011],
    ["兄弟", TEAM_COLORS.ACN011],
    ["中信", TEAM_COLORS.ACN011],
  ];
  return nameMap.find(([key]) => text.includes(key))?.[1] || "#9fc3ff";
}

function assetUrl(path) {
  if (!path) return "";
  return String(path).startsWith("http") ? path : `${CPBL_PUBLIC}${path}`;
}

function normalizeGame(g = {}) {
  const statusMap = { 1: "未開賽", 2: "比賽中", 3: "已結束", 4: "先發打序", 8: "比賽暫停" };
  const statusCode = g.GameStatus;
  const state = battingState(g);
  return {
    id: `${g.Year}-${g.KindCode}-${g.GameSno}`,
    year: g.Year,
    kindCode: g.KindCode,
    gameSno: g.GameSno,
    field: fieldName(g.FieldAbbe || g.FieldNo || ""),
    fieldCode: g.FieldNo || g.FieldAbbe || "",
    date: g.GameDate || "",
    time: g.GameDateTimeS || "",
    statusCode,
    status: g.GameStatusChi || statusMap[g.GameStatus] || "未知",
    away: g.VisitingTeamName,
    home: g.HomeTeamName,
    awayCode: g.VisitingTeamCode,
    homeCode: g.HomeTeamCode,
    awayColor: teamColor(g.VisitingTeamCode, g.VisitingTeamName),
    homeColor: teamColor(g.HomeTeamCode, g.HomeTeamName),
    awayLogo: assetUrl(g.VisitingClubBigImgPath || g.VisitingClubSmallImgPath),
    homeLogo: assetUrl(g.HomeClubBigImgPath || g.HomeClubSmallImgPath),
    awayScore: g.VisitingTotalScore ?? g.VisitingScore,
    homeScore: g.HomeTotalScore ?? g.HomeScore,
    awayStarter: g.VisitingFirstMover || "",
    homeStarter: g.HomeFirstMover || "",
    inning: g.CurtSeq || "",
    battingSide: g.CurtVisitingHomeType || "",
    inningText: inningText(g.CurtSeq || "", g.CurtVisitingHomeType || "", statusCode),
    pitcher: g.PitcherName || state.pitcher || "",
    hitter: g.HitterName || state.hitter || "",
    ...state,
    briefing: stripHtml(g.Briefing || ""),
    weather: g.WeatherDesc || g.Weather || "",
    pauseReason: Number(g.GameStatus) === 3 ? "" : pauseReasonFrom(g.GameStatusChi, g.Briefing, g.GameResult),
    audienceCnt: g.AudienceCnt || g.AudienceCntBackend || 0,
    winningPitcher: g.WinningPitcherName || "",
    losingPitcher: g.LosePitcherName || "",
    savePitcher: g.CloserPitcherName || "",
    mvp: g.MvpName || g.MvpEnName || "",
    liveUrl: g.LiveUrl || "",
    vodUrl: g.VodUrl || "",
  };
}

async function fetchGames(env, gameDate = "", firstTeamOnly = false) {
  const data = await postCpbl(env, "/home/getdetaillist", { GameSno: "", KindCode: "", GameDate: gameDate });
  const games = [];
  for (const key of ["GameADetailJson", "GameDDetailJson", "GameDetailJson"]) {
    games.push(...parseJsonMaybe(data[key], []));
  }
  const seen = new Set();
  const out = [];
  for (const g of games) {
    if (firstTeamOnly && g.KindCode !== "A") continue;
    const key = `${g.Year}-${g.KindCode}-${g.GameSno}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalizeGame(g));
    }
  }
  return { ok: true, updatedAt: nowText(), source: CPBL_PUBLIC, games: out };
}

async function fetchGameDetail(env, year, kindCode, gameSno, status) {
  const data = await postCpbl(env, "/home/gamedetail", {
    GameSno: String(gameSno),
    Year: String(year),
    KindCode: String(kindCode),
    GameStatus: String(status || ""),
  });
  const d = parseJsonMaybe(data.CurtGameDetailJson, {});
  const base = normalizeGame(d);
  let liveLogs = [];
  let liveDetail = {};
  let battingRows = [];
  let pitchingRows = [];
  try {
    const live = await postCpblLive(env, year, kindCode, gameSno);
    liveLogs = parseJsonMaybe(live.LiveLogJson, []);
    liveDetail = parseJsonMaybe(live.CurtGameDetailJson, {});
    battingRows = parseJsonMaybe(live.BattingJson, []);
    pitchingRows = parseJsonMaybe(live.PitchingJson, []);
  } catch {
    liveLogs = [];
    liveDetail = {};
  }

  const playerNameByAcnt = (acnt) => {
    if (!acnt) return "";
    return (
      battingRows.find((row) => row.HitterAcnt === acnt)?.HitterName ||
      pitchingRows.find((row) => row.PitcherAcnt === acnt)?.PitcherName ||
      ""
    );
  };

  const recentLogs = liveLogs
    .slice(-6)
    .map((log) => {
      const content = stripHtml(log.Content || "");
      if (!content) return null;
      const side = String(log.VisitingHomeType) === "1" ? "上" : String(log.VisitingHomeType) === "2" ? "下" : "";
      return {
        inning: log.InningSeq && side ? `${log.InningSeq}局 ${side === "上" ? "▲" : "▼"}` : log.InningSeq ? `第${log.InningSeq}局` : "",
        text: content,
        hitter: log.HitterName || "",
        pitcher: log.PitcherName || "",
      };
    })
    .filter(Boolean);

  const scoringPlays = [];
  let prevAway = null;
  let prevHome = null;
  for (const log of liveLogs) {
    const awayScore = log.VisitingScore == null ? null : Number(log.VisitingScore);
    const homeScore = log.HomeScore == null ? null : Number(log.HomeScore);
    if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
    if (prevAway == null || prevHome == null) {
      prevAway = awayScore;
      prevHome = homeScore;
      continue;
    }
    const awayRuns = Math.max(0, awayScore - prevAway);
    const homeRuns = Math.max(0, homeScore - prevHome);
    if (awayRuns || homeRuns) {
      const side = String(log.VisitingHomeType) === "1" ? "上" : String(log.VisitingHomeType) === "2" ? "下" : "";
      scoringPlays.push({
        inning: log.InningSeq && side ? `${log.InningSeq}局 ${side === "上" ? "▲" : "▼"}` : log.InningSeq ? `第${log.InningSeq}局` : "",
        teamSide: awayRuns ? "away" : "home",
        runs: awayRuns || homeRuns,
        hitter: log.HitterName || "",
        text: stripHtml(log.Content || ""),
        awayScore,
        homeScore,
      });
    }
    prevAway = awayScore;
    prevHome = homeScore;
  }

  const latest = liveLogs.at(-1) || {};
  const latestText = stripHtml(latest.Content || "");
  const latestLogTime = latest.UpdateTime || latest.CreateTime || "";
  let currentHitterStats = {};
  if (latest.HitterAcnt) {
    const row = battingRows.find((x) => x.HitterAcnt === latest.HitterAcnt);
    if (row) {
      currentHitterStats = {
        pa: row.PlateAppearances || 0,
        ab: row.HittingCnt || 0,
        h: row.HitCnt || 0,
        rbi: row.RunBattedINCnt || 0,
        r: row.ScoreCnt || 0,
        hr: row.HomeRunCnt || 0,
        bb: row.BasesONBallsCnt || 0,
        so: row.StrikeOutCnt || 0,
      };
    }
  }

  if (latest && Object.keys(latest).length) {
    const liveState = battingStateFromLog(latest);
    Object.assign(base, liveState, {
      pitcher: latest.PitcherName || liveDetail.PitcherName || d.PitcherName || base.pitcher || "",
      hitter: latest.HitterName || liveDetail.HitterName || d.HitterName || base.hitter || "",
      inning: latest.InningSeq || base.inning,
      battingSide: latest.VisitingHomeType || base.battingSide,
      inningText: inningText(latest.InningSeq, latest.VisitingHomeType, base.statusCode),
      pitchCnt: latest.PitchCnt || base.pitchCnt || "",
      latestLogTime,
      pauseReason:
        Number(liveDetail.GameStatus || base.statusCode || 0) === 3
          ? ""
          : pauseReasonFrom(liveDetail.GameStatusChi, latestText, liveDetail.Briefing, liveDetail.GameResult) || base.pauseReason || "",
      awayScore: latest.VisitingScore ?? base.awayScore,
      homeScore: latest.HomeScore ?? base.homeScore,
    });
  }

  Object.assign(base, {
    scoreboard: {
      away: d.VisitingScoreboards || [],
      home: d.HomeScoreboards || [],
    },
    liveText: latestText,
    recentLiveTexts: recentLogs,
    scoringPlays: scoringPlays.slice(-4),
    currentBatting: d.CurtBatting || [],
    currentHitters: d.CurtHitterBattings || [],
    currentHitterStats,
    awayPitchers: d.VisitingPitcherData || [],
    homePitchers: d.HomePitcherData || [],
    winningPitcher: liveDetail.WinningPitcherName || d.WinningPitcherName || base.winningPitcher || "",
    losingPitcher: liveDetail.LosePitcherName || d.LosePitcherName || base.losingPitcher || "",
    savePitcher: liveDetail.CloserPitcherName || d.CloserPitcherName || base.savePitcher || "",
    mvp:
      playerNameByAcnt(liveDetail.MvpAcnt || d.MvpAcnt) ||
      liveDetail.MvpName ||
      d.MvpName ||
      liveDetail.MvpEnName ||
      d.MvpEnName ||
      base.mvp ||
      "",
    awayStarterReport: stripHtml(d.VisitingStatersPitcherHtml || ""),
    homeStarterReport: stripHtml(d.HomeStatersPitcherHtml || ""),
    awayTeamReport: stripHtml(d.VisitingStartersHtml || ""),
    homeTeamReport: stripHtml(d.HomeStartersHtml || ""),
  });
  return { ok: true, updatedAt: nowText(), source: CPBL_PUBLIC, game: base };
}

async function loadReminders(env) {
  if (env.CPBL_REMINDERS) return parseJsonMaybe(await env.CPBL_REMINDERS.get(REMINDERS_KEY), []);
  globalThis.__cpblReminders ||= [];
  return JSON.parse(JSON.stringify(globalThis.__cpblReminders));
}

async function saveReminders(env, items) {
  if (env.CPBL_REMINDERS) await env.CPBL_REMINDERS.put(REMINDERS_KEY, JSON.stringify(items));
  else globalThis.__cpblReminders = JSON.parse(JSON.stringify(items));
}

async function addReminder(env, item) {
  const items = await loadReminders(env);
  const reminder = {
    ...item,
    id: `r${Date.now()}`,
    sent: false,
    createdAt: nowText(),
  };
  items.push(reminder);
  await saveReminders(env, items);
  return reminder;
}

async function deleteReminder(env, id) {
  const items = (await loadReminders(env)).filter((x) => x.id !== id);
  await saveReminders(env, items);
  return items;
}

async function markReminderSent(env, id) {
  const items = await loadReminders(env);
  for (const item of items) {
    if (item.id === id) {
      item.sent = true;
      item.sentAt = nowText();
    }
  }
  await saveReminders(env, items);
  return items;
}


async function debugCpbl() {
  const result = {
    ok: false,
    service: "Leokuo API / CPBL debug v4",
    version: "4.0.0",
    time: nowText(),
    steps: {},
  };

  const pickHeaders = (response) => ({
    server: response.headers.get("server") || "",
    cfRay: response.headers.get("cf-ray") || "",
    cfCacheStatus: response.headers.get("cf-cache-status") || "",
    contentType: response.headers.get("content-type") || "",
    location: response.headers.get("location") || "",
    setCookiePresent: Boolean(response.headers.get("set-cookie")),
  });

  try {
    // Step 1: CPBL homepage
    const home = await fetchCpbl("/", {
      redirect: "manual",
      headers: browserHeaders(),
    });
    const homeText = await home.text();
    const token = inputValue(homeText, "__RequestVerificationToken");
    const cookie = cookiesFrom(home);

    result.steps.home = {
      status: home.status,
      ok: home.ok,
      tokenFound: Boolean(token),
      cookieNames: cookieNames(cookie),
      ...pickHeaders(home),
      bodyPreview: stripHtml(homeText).slice(0, 220),
    };

    if (!home.ok || !token) {
      result.error = !home.ok
        ? `CPBL 首頁回應 ${home.status}`
        : "首頁成功，但找不到 __RequestVerificationToken";
      return result;
    }

    // Step 2: POST exactly to the official hostname only.
    const body = new URLSearchParams({
      __RequestVerificationToken: token,
      GameSno: "",
      KindCode: "",
      GameDate: "",
    });

    const post = await fetchCpbl("/home/getdetaillist", {
      method: "POST",
      redirect: "manual",
      body,
      headers: {
        ...browserHeaders({
          ajax: true,
          referer: `${CPBL_PUBLIC}/`,
          includeOrigin: true,
        }),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    const postText = await post.text();

    result.steps.gamesPost = {
      status: post.status,
      ok: post.ok,
      cookieSent: Boolean(cookie),
      cookieNames: cookieNames(cookie),
      ...pickHeaders(post),
      bodyPreview: stripHtml(postText).slice(0, 360),
    };

    result.ok = post.ok;

    if (!post.ok) {
      result.error = `CPBL games POST 回應 ${post.status}`;

      if (/error code:\s*1003/i.test(postText)) {
        result.hint =
          "上游回傳 Cloudflare Error 1003。v4 已完全移除直接 IP、Host override 與 resolveOverride；若仍出現 1003，代表問題不是舊的 IP fallback，而是上游對這類 Worker POST 的限制。";
      }
    }

    return result;
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://baseball.leokuo.com",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Vary": "Origin",
      },
    });
  }

  const apiPath = url.pathname.replace(/^\/cpbl/, "") || "/";

  try {
    if (request.method === "GET" && (apiPath === "/" || apiPath === "/health")) {
      return jsonResponse({
        ok: true,
        service: "Leokuo API",
        version: "4.0.0",
        module: "cpbl",
        time: nowText(),
        endpoints: ["/cpbl/games", "/cpbl/game", "/cpbl/reminders", "/cpbl/health", "/cpbl/debug"],
        kvConfigured: Boolean(env.CPBL_REMINDERS),
        proxyConfigured: Boolean(proxyBaseUrl(env)),
      });
    }
    if (request.method === "GET" && apiPath === "/debug") {
      return jsonResponse(await debugCpbl());
    }
    if (request.method === "GET" && apiPath === "/games") {
      const result = await fetchGames(env, url.searchParams.get("date") || "", url.searchParams.get("first") !== "0");
      return jsonResponse(result, 200, "public, max-age=5, s-maxage=20");
    }
    if (request.method === "GET" && apiPath === "/game") {
      const result = await fetchGameDetail(env, url.searchParams.get("year"), url.searchParams.get("kindCode"), url.searchParams.get("gameSno"), url.searchParams.get("status") || "");
      return jsonResponse(result, 200, "public, max-age=2, s-maxage=5");
    }
    if (request.method === "GET" && apiPath === "/reminders") return jsonResponse({ ok: true, reminders: await loadReminders(env) });
    if (request.method === "POST" && apiPath === "/reminders") return jsonResponse({ ok: true, reminder: await addReminder(env, await request.json()) });
    if (request.method === "POST" && apiPath === "/reminders/delete") { const body = await request.json(); return jsonResponse({ ok: true, reminders: await deleteReminder(env, body.id) }); }
    if (request.method === "POST" && apiPath === "/reminders/sent") { const body = await request.json(); return jsonResponse({ ok: true, reminders: await markReminderSent(env, body.id) }); }
    if (request.method === "POST" && apiPath === "/workflow/pdf") return jsonResponse({ ok: false, error: "Cloudflare Worker 版目前不做伺服器端 PDF 文字抽取；CSV/TXT/JSON 流程表仍可直接在前端匯入。" }, 501);
    return jsonResponse({ ok: false, error: "not found" }, 404);
  } catch (error) {
    console.error("API error", error);
    return jsonResponse({ ok: false, error: error?.message || String(error), service: "Leokuo API / CPBL" }, 502);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
