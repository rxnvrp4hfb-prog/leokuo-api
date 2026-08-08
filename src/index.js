// The www host is served through a CDN path that loops Worker-originated POSTs
// back through Cloudflare and returns 404 after its cookie challenge. The
// official apex host reaches CPBL's origin directly and exposes the same API.
const CPBL_PUBLIC = "https://cpbl.com.tw";
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

  // HiNet CDN may answer the first Worker request with 308 and a __chtcdn
  // cookie. It is a cookie challenge, not a useful redirect: retry the same
  // canonical URL with the accumulated cookie jar.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetchCpbl("/", {
      redirect: "manual",
      headers: {
        ...browserHeaders(),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    lastStatus = response.status;
    const html = await response.text();
    cookie = mergeCookies(cookie, cookiesFrom(response));

    if (response.ok) token = inputValue(html, "__RequestVerificationToken") || token;

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
      let cookie = session.cookie;

      for (let challengeAttempt = 1; challengeAttempt <= 4; challengeAttempt++) {
        const response = await fetchCpbl(path, {
          method: "POST",
          redirect: "manual",
          body: new URLSearchParams({
            __RequestVerificationToken: session.token,
            ...payload,
          }),
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

        cookie = mergeCookies(cookie, cookiesFrom(response));
        if (response.ok) return response.json();

        const preview = await response.text().catch(() => "");
        lastError = new Error(
          `CPBL API 回應 ${response.status}${preview ? `：${stripHtml(preview).slice(0, 160)}` : ""}`,
        );

        if (![301, 302, 307, 308].includes(response.status)) break;
      }
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
    version: "4.1.0",
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
    if (request.method === "POST" && apiPath === "/admin/register-runshow-commands") {
      if (!env.LOGIN_SYNC_SECRET || request.headers.get("Authorization") !== `Bearer ${env.LOGIN_SYNC_SECRET}`) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID) return jsonResponse({ ok: false, error: "Discord command settings are incomplete" }, 503);
      const option = (type, name, description, required = false) => ({ type, name, description, required });
      const commands = [
        { name: "allow", description: "允許 Gmail 帳號進入 CPBL 網站", options: [option(3, "email", "Email 地址", true)] },
        { name: "remove", description: "移除 CPBL 網站允許帳號", options: [option(3, "email", "Email 地址", true)] },
        { name: "list", description: "查看 CPBL 網站允許帳號" },
        { name: "status", description: "立即檢查網站與 API 狀態" },
        { name: "sync-logins", description: "立即同步新的登入紀錄" },
        { name: "runshow-password", description: "更新 Run of Show 活動密碼", options: [option(3, "password", "新的活動密碼", true)] },
        { name: "runshow-admin-password", description: "更新 Run of Show 管理員密碼", options: [option(3, "password", "新的管理員密碼", true)] },
        { name: "runshow-upload", description: "發布 Run of Show 流程表", options: [option(11, "file", "PDF、CSV、TXT 或 JSON", true)] },
        { name: "runshow-event", description: "設定活動期間與共用密碼", options: [option(3, "password", "活動密碼", true), option(3, "start", "開始時間 YYYY-MM-DD HH:mm", true), option(3, "end", "結束時間 YYYY-MM-DD HH:mm"), option(5, "continuous", "持續模式，不自動清除")] },
        { name: "runshow-extend", description: "延長活動結束時間", options: [option(3, "end", "新的結束時間 YYYY-MM-DD HH:mm", true)] },
        { name: "runshow-continuous", description: "開啟或關閉持續模式", options: [option(5, "enabled", "是否持續運作", true), option(3, "end", "關閉時的新結束時間 YYYY-MM-DD HH:mm")] },
        { name: "runshow-end", description: "立即結束活動並清除流程與密碼" },
        { name: "runshow-event-status", description: "查看活動期間、持續模式與流程表狀態" },
      ];
      const applicationResponse = await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
      const application = await applicationResponse.json().catch(() => ({}));
      if (!applicationResponse.ok || !application.id) return jsonResponse({ ok: false, error: application.message || `Discord application ${applicationResponse.status}` }, 502);
      const discordResponse = await fetch(`https://discord.com/api/v10/applications/${application.id}/commands`, {
        method: "PUT",
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands),
      });
      const result = await discordResponse.json().catch(() => ({}));
      return discordResponse.ok ? jsonResponse({ ok: true, count: Array.isArray(result) ? result.length : 0 }) : jsonResponse({ ok: false, error: result.message || `Discord ${discordResponse.status}` }, 502);
    }
    if (request.method === "POST" && apiPath === "/admin/runshow-reminder") {
      if (!env.RUNSHOW_NOTIFY_SECRET || request.headers.get("Authorization") !== `Bearer ${env.RUNSHOW_NOTIFY_SECRET}`) return jsonResponse({ ok: false, error: "not found" }, 404);
      if (!env.DISCORD_BOT_TOKEN) return jsonResponse({ ok: false, error: "Discord unavailable" }, 503);
      const discordResponse = await fetch("https://discord.com/api/v10/channels/1535607596441018458/messages", {
        method: "POST",
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "🔔 **Runshow 流程表提醒**\n有工作人員提醒：管理員尚未發布本場流程表。\nhttps://runofshow.leokuo.com", allowed_mentions: { parse: [] } }),
      });
      return discordResponse.ok ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: `Discord ${discordResponse.status}` }, 502);
    }
    if (request.method === "POST" && apiPath === "/admin/sync-login-logs") {
      if (!env.LOGIN_SYNC_SECRET || request.headers.get("Authorization") !== `Bearer ${env.LOGIN_SYNC_SECRET}`) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }
      const sent = await syncAccessLoginLogs(env);
      return jsonResponse({ ok: true, sent });
    }
    // Do not advertise implementation details or available routes at the API root.
    if (request.method === "GET" && apiPath === "/") {
      return jsonResponse({ ok: false, error: "not found" }, 404);
    }
    if (request.method === "GET" && apiPath === "/health") {
      return jsonResponse({
        ok: true,
        time: nowText(),
      });
    }
    if (request.method === "GET" && apiPath === "/debug") {
      if (!env.DEBUG_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.DEBUG_TOKEN}`) {
        return jsonResponse({ ok: false, error: "not found" }, 404);
      }
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

function loginEventText(event) {
  const time = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(event.created_at));
  const result = event.allowed ? "✅ 登入成功" : "❌ 登入失敗";
  return `${result}\n帳號：${event.user_email || "未知"}\n網站：${event.app_domain || "baseball.leokuo.com"}\n時間：${time}`;
}

async function postDiscordLogin(env, event) {
  const response = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_LOGIN_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: loginEventText(event), allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Discord login log failed: ${response.status}`);
}

async function syncAccessLoginLogs(env) {
  if (!env.CLOUDFLARE_LOGS_TOKEN || !env.DISCORD_BOT_TOKEN || !env.LOGIN_LOG_STATE) {
    throw new Error("Login log settings are incomplete");
  }
  const until = new Date();
  const since = new Date(until.getTime() - 10 * 60 * 1000);
  const query = new URLSearchParams({
    since: since.toISOString(),
    until: until.toISOString(),
    direction: "asc",
    limit: "100",
  });
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/logs/access_requests?${query}`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_LOGS_TOKEN}` } },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.errors?.[0]?.message || `Cloudflare login logs failed: ${response.status}`);
  }
  const events = (payload.result || []).filter((event) =>
    event.app_uid === env.CLOUDFLARE_ACCESS_APP_ID || event.app_domain === "baseball.leokuo.com",
  );
  let sent = 0;
  for (const event of events) {
    const eventId = event.ray_id || `${event.created_at}:${event.user_email}:${event.allowed}`;
    const key = `discord-login:${eventId}`;
    if (await env.LOGIN_LOG_STATE.get(key)) continue;
    await postDiscordLogin(env, event);
    await env.LOGIN_LOG_STATE.put(key, "1", { expirationTtl: 2592000 });
    sent += 1;
  }
  return sent;
}

function taipeiHour() {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date()));
}

async function postDiscordMonitor(env, content) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_MONITOR_CHANNEL_ID) throw new Error("Monitor Discord settings are incomplete");
  const response = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_MONITOR_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Discord monitor notification failed: ${response.status}`);
}

async function probe(url, validate = (response) => response.ok) {
  const started = Date.now();
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    const ok = await validate(response, body);
    return { ok, detail: ok ? `${response.status}｜${Date.now() - started}ms` : `${response.status}｜${body.slice(0, 160)}` };
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  }
}

async function probeWithRetry(url, validate, attempts = 3) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = await probe(url, validate);
    if (result.ok) return { ...result, attempts: attempt };
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ...result, detail: `${result.detail}｜已重試 ${attempts} 次`, attempts };
}

async function monitorServices(env) {
  if (!env.LOGIN_LOG_STATE) throw new Error("Monitor state KV is unavailable");
  const checks = [
    {
      id: "baseball-site",
      name: "baseball.leokuo.com｜公開入口／Cloudflare Access",
      run: () => probe("https://baseball.leokuo.com/"),
    },
    {
      id: "baseball-source",
      name: "baseball.leokuo.com｜網站程式來源／GitHub",
      run: () => probe("https://raw.githubusercontent.com/rxnvrp4hfb-prog/cpbl-baseball/main/index.html", (response, body) => response.ok && body.includes("CPBL")),
    },
    {
      id: "api-health",
      name: "api.leokuo.com｜API 主服務",
      run: () => probeWithRetry("https://api.leokuo.com/cpbl/health", (response, body) => {
        if (!response.ok) return false;
        try { return JSON.parse(body).ok === true; } catch { return false; }
      }),
    },
    {
      id: "runofshow-site",
      name: "runofshow.leokuo.com｜網站首頁／登入頁",
      run: () => probe("https://runofshow.leokuo.com/", (response, body) => response.ok && (body.includes("活動流程") || body.includes("登入"))),
    },
  ];
  const hour = taipeiHour();
  if (hour < 1 || hour >= 13) {
    checks.push({
      id: "cpbl-api",
      name: "api.leokuo.com｜CPBL 比賽資料／Vercel Proxy",
      run: () => probeWithRetry("https://api.leokuo.com/cpbl/games?ping=1", (response, body) => {
        if (!response.ok) return false;
        try { return JSON.parse(body).ok === true; } catch { return false; }
      }),
    });
  } else {
    const key = "service-monitor:cpbl-api";
    const previous = await env.LOGIN_LOG_STATE.get(key, "json");
    await env.LOGIN_LOG_STATE.put(key, JSON.stringify({ ok: true, state: "sleeping", checkedAt: new Date().toISOString() }));
    if (previous?.state !== "sleeping") {
      await postDiscordMonitor(env, `🌙 服務休眠中\n項目：api.leokuo.com｜CPBL 比賽資料／Vercel Proxy\n結果：依排程暫停資料抓取（01:00–13:00）\n時間：${nowText()}`);
    }
  }

  for (const check of checks) {
    const result = await check.run();
    const key = `service-monitor:${check.id}`;
    const previous = await env.LOGIN_LOG_STATE.get(key, "json");
    const state = result.ok ? "healthy" : "unhealthy";
    const previousState = previous?.state || (previous?.ok === false ? "unhealthy" : previous?.ok === true ? "healthy" : "unknown");
    await env.LOGIN_LOG_STATE.put(key, JSON.stringify({ ok: result.ok, state, checkedAt: new Date().toISOString() }));
    if ((!result.ok && previousState !== "unhealthy") || (result.ok && previousState === "unhealthy") || (result.ok && previousState === "sleeping")) {
      const status = previousState === "sleeping" && result.ok ? "☀️ 服務已啟動" : result.ok ? "✅ 服務已恢復" : "🚨 服務異常";
      await postDiscordMonitor(env, `${status}\n項目：${check.name}\n結果：${result.detail}\n時間：${nowText()}`);
    }
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      syncAccessLoginLogs(env),
      monitorServices(env),
    ]));
  },
};
