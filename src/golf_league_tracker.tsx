import { useState, useEffect, useCallback } from "react";
import { db } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

// ── TYPES ─────────────────────────────────────────────────────
interface Course { id: number; name: string; }
interface Player { id: number; name: string; startingAvg: number; guest?: boolean; }
interface Score { playerId: number; gross: number; }
interface CtpEntry { hole: string; winnerId: string | null; }
interface Round { id: number; week: number; date: string; courseId: number; side: "front" | "back"; par: number; scores: Score[]; ctp: CtpEntry[]; doublePoints?: boolean; }

// ── STORAGE ──────────────────────────────────────────────────
async function load(key: string, fallback: unknown) {
  try {
    const snap = await getDoc(doc(db, "league", key));
    return snap.exists() ? snap.data().value : fallback;
  } catch { return fallback; }
}
async function save(key: string, val: unknown) {
  try { await setDoc(doc(db, "league", key), { value: val }); } catch {}
}

type RoundResult = { player: Player; gross: number; modAvg: number; strokes: number; net: number };

// ── HANDICAP CALCULATIONS ────────────────────────────────────
// Modified Average: rolls forward each week based on actual score vs current avg.
// If player scored worse (gross > prevAvg): avg increases by only 20% of the difference.
// If player scored better (gross <= prevAvg): avg moves to the midpoint.
function calcModifiedAvg(prevAvg: number, gross: number): number {
  if (gross > prevAvg) {
    return Math.round((prevAvg + 0.2 * (gross - prevAvg)) * 100) / 100;
  } else {
    return Math.round((prevAvg + gross) / 2 * 100) / 100;
  }
}

// Returns the Modified Average to use when calculating strokes for a given round.
// roundIndex 0 = use startingAvg; roundIndex N = avg after N prior rounds.
function getModifiedAvgBeforeRound(player: Player, rounds: Round[], roundIndex: number): number {
  let avg = parseFloat(String(player.startingAvg));
  for (let i = 0; i < roundIndex; i++) {
    const score = rounds[i].scores.find(s => s.playerId === player.id);
    if (!score || score.gross === undefined || isNaN(score.gross)) continue;
    avg = calcModifiedAvg(avg, score.gross);
  }
  return avg;
}

// Strokes = (par − modifiedAvg) × factor, rounded to 1 decimal.
// Factor 0.83 applied when avg >= par (higher handicapper); full difference when avg < par.
// Result is negative for high-handicappers (lowers net score) and positive for scratch/plus players.
function calcStrokes(modAvg: number, par: number): number {
  if (modAvg >= par) {
    return Math.round((par - modAvg) * 0.83 * 10) / 10;
  } else {
    return Math.round((par - modAvg) * 10) / 10;
  }
}

// ── PRIZE MONEY ──────────────────────────────────────────────
interface PrizeMoney {
  purse: number;
  ctpPool: number;
  ctpPayouts: { player: Player; amount: number }[];
  placements: { player: Player | null; label: string; amount: number }[];
}

function roundTo5(val: number): number {
  return Math.round(val / 5) * 5;
}

function calcPrizeMoney(round: Round, results: RoundResult[], players: Player[]): PrizeMoney {
  const playerCount = round.scores.length;
  const purse = playerCount * 10;
  const ctpCount = round.ctp ? round.ctp.length : 0;

  // Determine CTP pool and placement splits
  let ctpPool = 0;
  let splits: number[] = [];

  if (playerCount <= 7) {
    ctpPool = 0;
    splits = [2 / 3, 1 / 3];
  } else if (playerCount <= 11) {
    ctpPool = ctpCount >= 3 ? 15 : 10;
    splits = [0.5, 0.3, 0.2];
  } else {
    ctpPool = ctpCount >= 3 ? 30 : 20;
    splits = [0.4, 0.3, 0.2, 0.1];
  }

  const remainingPurse = purse - ctpPool;

  // Placement payouts — round each to nearest $5, last place gets remainder
  const placements: PrizeMoney["placements"] = [];
  let leftover = remainingPurse;
  const labels = ["1st", "2nd", "3rd", "4th"];
  for (let i = 0; i < splits.length; i++) {
    const player = results[i]?.player ?? null;
    let amount: number;
    if (i < splits.length - 1) {
      amount = roundTo5(remainingPurse * splits[i]);
      leftover -= amount;
    } else {
      amount = leftover; // last place absorbs rounding remainder
    }
    placements.push({ player, label: labels[i], amount });
  }

  // CTP payouts — per-hole value = ctpPool / number of hole-wins (not holes configured)
  const winningEntries = round.ctp ? round.ctp.filter(c => c.hole && c.winnerId) : [];
  const totalWins = winningEntries.length;
  const perWin = totalWins > 0 ? ctpPool / totalWins : 0;

  const ctpMap: Record<string, { player: Player; amount: number }> = {};
  winningEntries.forEach(c => {
    const pid = String(c.winnerId);
    const player = players.find(p => String(p.id) === pid);
    if (!player) return;
    if (ctpMap[pid]) {
      ctpMap[pid].amount += perWin;
    } else {
      ctpMap[pid] = { player, amount: perWin };
    }
  });
  const ctpPayouts = Object.values(ctpMap);

  return { purse, ctpPool, ctpPayouts, placements };
}

// ── CGI CUP POINTS ───────────────────────────────────────────
const PLACEMENT_POINTS = [120, 90, 65, 45, 30, 20, 16, 12, 9, 6];

function calcPoints(rank: number, doublePoints: boolean): number {
  const placePower = doublePoints ? 2 : 1;
  const placementPts = rank >= 1 && rank <= 10 ? PLACEMENT_POINTS[rank - 1] : 0;
  return placementPts * placePower + 10; // +10 participation always (guests excluded at call site)
}

// ── CONFIRM DIALOG ───────────────────────────────────────────
function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "28px 32px", maxWidth: 360, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.2)", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <p style={{ margin: "0 0 20px", fontSize: 15, color: "#333", lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button onClick={onCancel} style={{ ...btnStyle("#888"), padding: "9px 22px" }}>Cancel</button>
          <button onClick={onConfirm} style={{ ...btnStyle("#c0392b"), padding: "9px 22px" }}>Yes, Remove</button>
        </div>
      </div>
    </div>
  );
}

// ── RESPONSIVE HOOK ──────────────────────────────────────────
// ── ADMIN PIN ─────────────────────────────────────────────────
const ADMIN_PIN = "2626";

// ── APP ──────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("leaderboard");
  const [isAdmin, setIsAdmin] = useState(false);
  const [players, setPlayersRaw] = useState([]);
  const [rounds, setRoundsRaw] = useState([]);
  const [courses, setCoursesRaw] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const promptAdmin = () => {
    const entered = window.prompt("Enter admin PIN:");
    if (entered === ADMIN_PIN) {
      setIsAdmin(true);
    } else if (entered !== null) {
      alert("Incorrect PIN.");
    }
  };

  useEffect(() => {
    Promise.all([
      load("golf_players", []),
      load("golf_rounds", []),
      load("golf_courses", []),
    ]).then(([p, r, c]) => {
      setPlayersRaw(p); setRoundsRaw(r); setCoursesRaw(c); setLoaded(true);
    });
  }, []);

  const setPlayers = useCallback((updater) => {
    setPlayersRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      save("golf_players", next);
      return next;
    });
  }, []);

  const setRounds = useCallback((updater) => {
    setRoundsRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      save("golf_rounds", next);
      return next;
    });
  }, []);

  const setCourses = useCallback((updater) => {
    setCoursesRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      save("golf_courses", next);
      return next;
    });
  }, []);

  if (!loaded) return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Loading...</div>;

  const adminTabs = ["players", "courses", "scores"] as const;
  const publicTabs = ["leaderboard", "standings", "history", "info"] as const;
  const allTabs = [...adminTabs, ...publicTabs] as const;
  const tabLabels: Record<typeof allTabs[number], string> = { players: "👤 Players", courses: "🗺️ Courses", scores: "📝 Enter Scores", leaderboard: "🏅 Leaderboard", standings: "🏆 Standings", history: "📋 Season History", info: "ℹ️ How It Works" };
  const visibleTabs = isAdmin ? allTabs : publicTabs;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#f0f4f0", minHeight: "100vh", paddingBottom: 40 }}>
      <div style={{ background: "linear-gradient(135deg, #1a5c2a, #2d8a45)", color: "#fff", padding: "18px 24px 0", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>⛳ CGI CUP</h1>
          <button onClick={isAdmin ? () => setIsAdmin(false) : promptAdmin} style={{ background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            {isAdmin ? "🔓 Admin" : "🔒 Admin"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 14, flexWrap: "wrap" }}>
          {visibleTabs.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: tab === t ? "#fff" : "transparent",
              color: tab === t ? "#1a5c2a" : "rgba(255,255,255,0.85)",
              border: "none", borderRadius: "8px 8px 0 0", padding: "8px 14px",
              fontWeight: tab === t ? 700 : 400, cursor: "pointer", fontSize: 13,
            }}>{tabLabels[t]}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: "24px 16px", maxWidth: 900, margin: "0 auto" }}>
        {tab === "players"     && <PlayersTab     players={players} setPlayers={setPlayers} />}
        {tab === "courses"     && <CoursesTab     courses={courses} setCourses={setCourses} />}
        {tab === "scores"      && <ScoresTab      players={players} rounds={rounds} setRounds={setRounds} courses={courses} />}
        {tab === "leaderboard" && <LeaderboardTab players={players} rounds={rounds} courses={courses} />}
        {tab === "history"     && <HistoryTab     players={players} rounds={rounds} courses={courses} />}
        {tab === "standings"   && <StandingsTab   players={players} rounds={rounds} />}
        {tab === "info"        && <InfoTab />}
      </div>
    </div>
  );
}

// ── COURSES TAB ──────────────────────────────────────────────
function CoursesTab({ courses, setCourses }: { courses: Course[]; setCourses: (u: (prev: Course[]) => Course[]) => void }) {
  const [name, setName] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [confirm, setConfirm] = useState<Course | null>(null);

  const addCourse = () => {
    if (!name.trim()) return;
    setCourses(prev => [...prev, { id: Date.now(), name: name.trim() }]);
    setName("");
  };

  const saveEdit = (id: number) => {
    setCourses(prev => prev.map(c => c.id === id ? { ...c, name: editName.trim() } : c));
    setEditId(null);
  };

  const doRemove = () => {
    if (!confirm) return;
    setCourses(prev => prev.filter(c => c.id !== confirm.id));
    setConfirm(null);
  };

  return (
    <div>
      {confirm && <ConfirmDialog message={`Remove "${confirm.name}"?`} onConfirm={doRemove} onCancel={() => setConfirm(null)} />}
      <Card title="Add Course">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Course Name">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Plum Creek GC" style={{ ...inputStyle, minWidth: 260 }} onKeyDown={e => e.key === "Enter" && addCourse()} />
          </Field>
          <button onClick={addCourse} style={btnStyle("#1a5c2a")}>Add Course</button>
        </div>
      </Card>

      <Card title={`Courses (${courses.length})`}>
        {courses.length === 0 && <p style={{ color: "#888", margin: 0 }}>No courses yet. Add one above.</p>}
        {courses.map(c => (
          <div key={c.id} style={{ border: "1px solid #e0eee0", borderRadius: 8, padding: "14px 16px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
            {editId === c.id ? (
              <>
                <input value={editName} onChange={e => setEditName(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                <button onClick={() => saveEdit(c.id)} style={btnSmall("#1a5c2a")}>Save</button>
                <button onClick={() => setEditId(null)} style={btnSmall("#888")}>Cancel</button>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#1a5c2a", flex: 1 }}>{c.name}</div>
                <button onClick={() => { setEditId(c.id); setEditName(c.name); }} style={btnSmall("#2d6a8a")}>Edit</button>
                <button onClick={() => setConfirm(c)} style={btnSmall("#c0392b")}>Remove</button>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── PLAYERS TAB ──────────────────────────────────────────────
function PlayersTab({ players, setPlayers }) {
  const [name, setName] = useState("");
  const [avg, setAvg] = useState("");
  const [guest, setGuest] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editAvg, setEditAvg] = useState("");
  const [editGuest, setEditGuest] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const addPlayer = () => {
    if (!name.trim() || !avg) return;
    setPlayers(prev => [...prev, { id: Date.now(), name: name.trim(), startingAvg: parseFloat(avg), guest }]);
    setName(""); setAvg(""); setGuest(false);
  };

  const saveEdit = (id) => {
    setPlayers(prev => prev.map(p => p.id === id
      ? { ...p, name: editName.trim(), startingAvg: parseFloat(editAvg), guest: editGuest }
      : p));
    setEditId(null);
  };

  const doRemove = () => {
    setPlayers(prev => prev.filter(p => p.id !== confirm.id));
    setConfirm(null);
  };

  return (
    <div>
      {confirm && <ConfirmDialog message={`Remove "${confirm.name}" from the roster?`} onConfirm={doRemove} onCancel={() => setConfirm(null)} />}
      <Card title="Add New Player">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Player Name">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" style={inputStyle} onKeyDown={e => e.key === "Enter" && addPlayer()} />
          </Field>
          <Field label="Starting Avg (9-hole)">
            <input type="number" value={avg} onChange={e => setAvg(e.target.value)} placeholder="e.g. 42" style={{ ...inputStyle, width: 130 }} />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#888", paddingBottom: 2, cursor: "pointer" }}>
            <input type="checkbox" checked={guest} onChange={e => setGuest(e.target.checked)} />
            Guest
          </label>
          <button onClick={addPlayer} style={btnStyle("#1a5c2a")}>Add Player</button>
        </div>
      </Card>

      <Card title={`Player Roster (${players.length})`}>
        {players.length === 0 && <p style={{ color: "#888", margin: 0 }}>No players yet. Add some above!</p>}
        {players.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0" }}>
              <Th>Name</Th><Th>Starting Avg</Th><Th>Actions</Th>
            </tr></thead>
            <tbody>
              {players.map(p => (
                <tr key={p.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                  <td style={tdStyle}>
                    {editId === p.id
                      ? <input value={editName} onChange={e => setEditName(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                      : <span>{p.name}{p.guest && <span style={{ marginLeft: 6, fontSize: 11, color: "#999", fontStyle: "italic" }}>guest</span>}</span>}
                  </td>
                  <td style={tdStyle}>
                    {editId === p.id
                      ? <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <input type="number" value={editAvg} onChange={e => setEditAvg(e.target.value)} style={{ ...inputStyle, width: 80 }} />
                          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "#888", cursor: "pointer" }}>
                            <input type="checkbox" checked={editGuest} onChange={e => setEditGuest(e.target.checked)} />
                            Guest
                          </label>
                        </div>
                      : p.startingAvg}
                  </td>
                  <td style={tdStyle}>
                    {editId === p.id
                      ? <><button onClick={() => saveEdit(p.id)} style={btnSmall("#1a5c2a")}>Save</button>{" "}<button onClick={() => setEditId(null)} style={btnSmall("#888")}>Cancel</button></>
                      : <><button onClick={() => { setEditId(p.id); setEditName(p.name); setEditAvg(p.startingAvg); setEditGuest(!!p.guest); }} style={btnSmall("#2d6a8a")}>Edit</button>{" "}
                          <button onClick={() => setConfirm(p)} style={btnSmall("#c0392b")}>Remove</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ── SCORES TAB ──────────────────────────────────────────────
function ScoresTab({ players, rounds, setRounds, courses }) {
  const nextWeek = rounds.length + 1;
  const [weekNum, setWeekNum] = useState(nextWeek);
  const [courseId, setCourseId] = useState("");
  const [side, setSide] = useState<"front" | "back">("front");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [par, setPar] = useState("");
  const [participating, setParticipating] = useState({});
  const [grossScores, setGrossScores] = useState({});
  const [ctpCount, setCtpCount] = useState(2);
  const [ctpHoles, setCtpHoles] = useState([{ hole: "", winnerId: "" }, { hole: "", winnerId: "" }]);
  const [doublePoints, setDoublePoints] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);

  const existingRound = rounds.find(r => r.week === weekNum);

  useEffect(() => {
    if (existingRound) {
      setDate(existingRound.date);
      setCourseId(existingRound.courseId ? String(existingRound.courseId) : "");
      setSide(existingRound.side || "front");
      setPar(existingRound.par ? String(existingRound.par) : "");
      const p = {}, g = {};
      existingRound.scores.forEach(s => { p[s.playerId] = true; g[s.playerId] = s.gross; });
      setParticipating(p); setGrossScores(g);
      if (existingRound.ctp) {
        setCtpCount(existingRound.ctp.length);
        setCtpHoles(existingRound.ctp.map(c => ({ hole: c.hole, winnerId: c.winnerId ?? "" })));
      }
      setDoublePoints(!!existingRound.doublePoints);
    } else {
      setParticipating({}); setGrossScores({});
      setCtpHoles(Array.from({ length: ctpCount }, () => ({ hole: "", winnerId: "" })));
      setDoublePoints(false);
    }
  }, [weekNum]);

  useEffect(() => {
    setCtpHoles(prev => {
      const arr = [...prev];
      while (arr.length < ctpCount) arr.push({ hole: "", winnerId: "" });
      return arr.slice(0, ctpCount);
    });
  }, [ctpCount]);

  const togglePlayer = (id) => setParticipating(prev => ({ ...prev, [id]: !prev[id] }));
  const setScore = (id, val) => setGrossScores(prev => ({ ...prev, [id]: val }));
  const updateCtp = (i, field, val) => setCtpHoles(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: val } : c));

  const saveRound = () => {
    if (!courseId) return alert("Please select a course.");
    const scores = players.filter(p => participating[p.id])
      .map(p => ({ playerId: p.id, gross: grossScores[p.id] !== undefined ? parseFloat(grossScores[p.id]) : "" }))
      .filter(s => s.gross !== "" && !isNaN(s.gross));
    if (scores.length === 0) return alert("Enter at least one score.");
    const ctp = ctpHoles.map(c => ({ hole: c.hole, winnerId: c.winnerId || null }));
    const roundPar = parseFloat(par) > 0 ? parseFloat(par) : 0;
    const round = { id: existingRound?.id || Date.now(), week: weekNum, date, courseId: parseInt(courseId), side, par: roundPar, scores, ctp, doublePoints };
    setRounds(prev => [...prev.filter(r => r.week !== weekNum), round].sort((a, b) => a.week - b.week));
    alert(`Week ${weekNum} scores saved!`);
  };

  const doDelete = () => {
    setRounds(prev => prev.filter(r => r.week !== confirm));
    setConfirm(null);
  };

  return (
    <div>
      {confirm !== null && (
        <ConfirmDialog
          message={`Remove all scores for Week ${confirm}? This cannot be undone.`}
          onConfirm={doDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
      <Card title="Enter Weekly Scores">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, alignItems: "flex-end" }}>
          <Field label="Week #">
            <input type="number" value={weekNum} min={1} onChange={e => setWeekNum(parseInt(e.target.value))} style={{ ...inputStyle, width: 70 }} />
          </Field>
          <Field label="Date">
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Course">
            <select value={courseId} onChange={e => setCourseId(e.target.value)} style={inputStyle}>
              <option value="">— Select course —</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="9 Played">
            <select value={side} onChange={e => setSide(e.target.value as "front" | "back")} style={inputStyle}>
              <option value="front">Front 9</option>
              <option value="back">Back 9</option>
            </select>
          </Field>
        </div>

        <div style={{ background: "#f5fbf5", border: "1px solid #cde8cd", borderRadius: 6, padding: "8px 14px", marginBottom: 12, fontSize: 13, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Par">
            <input type="number" value={par} onChange={e => setPar(e.target.value)} placeholder="e.g. 36" style={{ ...inputStyle, width: 80, fontSize: 13 }} />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555", paddingBottom: 2, cursor: "pointer", fontWeight: 600 }}>
            <input type="checkbox" checked={doublePoints} onChange={e => setDoublePoints(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />
            ⚡ Double Points Major Week
          </label>
        </div>

        {courses.length === 0 && <p style={{ color: "#c0392b", fontSize: 13 }}>⚠️ Add a course in the Courses tab first.</p>}
        {existingRound && <div style={{ background: "#fff8e1", border: "1px solid #f0c040", borderRadius: 6, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>⚠️ Editing existing Week {weekNum} scores.</div>}
        {players.length === 0 && <p style={{ color: "#888" }}>Add players first in the Players tab.</p>}

        {players.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0" }}>
              <Th>Playing?</Th><Th>Player</Th><Th>Gross Score</Th>
            </tr></thead>
            <tbody>
              {[...players].sort((a, b) => a.name.localeCompare(b.name)).map(p => (
                <tr key={p.id} style={{ borderBottom: "1px solid #eef2ee", background: participating[p.id] ? "#f5fbf5" : "transparent" }}>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <input type="checkbox" checked={!!participating[p.id]} onChange={() => togglePlayer(p.id)} style={{ width: 18, height: 18, cursor: "pointer" }} />
                  </td>
                  <td style={tdStyle}>{p.name}</td>
                  <td style={tdStyle}>
                    {participating[p.id]
                      ? <input type="number" value={grossScores[p.id] ?? ""} onChange={e => setScore(p.id, e.target.value)} placeholder="Score" style={{ ...inputStyle, width: 80 }} />
                      : <span style={{ color: "#bbb" }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "2px solid #e0f0e0" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15, color: "#1a5c2a" }}>📍 Closest to the Pin (CTP)</h3>
          <div style={{ marginBottom: 14 }}>
            <Field label="Number of CTP Holes">
              <select value={ctpCount} onChange={e => setCtpCount(parseInt(e.target.value))} style={{ ...inputStyle, width: 120 }}>
                <option value={2}>2 holes</option>
                <option value={3}>3 holes</option>
              </select>
            </Field>
          </div>
          <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
                <Th>CTP #</Th><Th>Hole Number</Th><Th>Winner</Th>
              </tr></thead>
              <tbody>
                {ctpHoles.map((c, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #eef2ee" }}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>CTP {i + 1}</td>
                    <td style={tdStyle}>
                      <input type="number" value={c.hole} onChange={e => updateCtp(i, "hole", e.target.value)} placeholder="e.g. 5" style={{ ...inputStyle, width: 60 }} />
                    </td>
                    <td style={tdStyle}>
                      <select value={c.winnerId} onChange={e => updateCtp(i, "winnerId", e.target.value)} style={{ ...inputStyle, minWidth: 130, maxWidth: "100%" }}>
                        <option value="">—</option>
                        {players.map((p: Player) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {players.length > 0 && <button onClick={saveRound} style={{ ...btnStyle("#1a5c2a"), marginTop: 16 }}>💾 Save Week {weekNum} Scores</button>}
      </Card>

      {rounds.length > 0 && (
        <Card title="Saved Rounds">
          <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, backgroundColor: "#fff" }}>
              <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
                <Th style={stickyTh1}>Week</Th><Th>Date</Th><Th>Course</Th><Th>9</Th><Th>Players</Th><Th>Actions</Th>
              </tr></thead>
              <tbody>
                {rounds.map((r: Round) => {
                  const course = courses.find((c: Course) => c.id === r.courseId);
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                      <td style={{ ...tdStyle, ...stickyTd1 }}>Week {r.week}</td>
                      <td style={tdStyle}>{r.date}</td>
                      <td style={tdStyle}>{course?.name ?? "—"}</td>
                      <td style={tdStyle}>{r.side === "front" ? "Front" : "Back"}</td>
                      <td style={tdStyle}>{r.scores.length}</td>
                      <td style={tdStyle}>
                        <button onClick={() => setWeekNum(r.week)} style={btnSmall("#2d6a8a")}>Edit</button>{" "}
                        <button onClick={() => setConfirm(r.week)} style={btnSmall("#c0392b")}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── LEADERBOARD TAB ──────────────────────────────────────────
function LeaderboardTab({ players, rounds, courses }) {
  const [selectedWeek, setSelectedWeek] = useState(() => rounds.length > 0 ? rounds[rounds.length - 1].week : null);

  useEffect(() => {
    if (rounds.length > 0 && !selectedWeek) setSelectedWeek(rounds[rounds.length - 1].week);
  }, [rounds]);

  if (rounds.length === 0) return <Card title="Leaderboard"><p style={{ color: "#888" }}>No rounds entered yet.</p></Card>;

  const round = rounds.find(r => r.week === selectedWeek);
  if (!round) return <Card title="Leaderboard"><p style={{ color: "#888" }}>Select a week.</p></Card>;

  const roundIndex = rounds.findIndex(r => r.week === selectedWeek);
  const course = courses.find(c => c.id === round.courseId);
  const par = round.par || 36;

  const results = round.scores.map(s => {
    const player = players.find(p => p.id === s.playerId);
    if (!player) return null;
    const modAvg = getModifiedAvgBeforeRound(player, rounds, roundIndex);
    const strokes = calcStrokes(modAvg, par);
    const net = s.gross + strokes;
    return { player, gross: s.gross, modAvg, strokes, net };
  }).filter((r): r is RoundResult => r !== null)
    .sort((a: RoundResult, b: RoundResult) => a.net - b.net);

  const prize = calcPrizeMoney(round, results, players);

  return (
    <div>
      <Card title="Weekly Leaderboard">
        <div style={{ marginBottom: 16 }}>
          <Field label="Select Week">
            <select value={selectedWeek ?? ""} onChange={e => setSelectedWeek(parseInt(e.target.value))} style={inputStyle}>
              {rounds.map(r => {
                const c = courses.find(x => x.id === r.courseId);
                return <option key={r.week} value={r.week}>Week {r.week} — {r.date} ({c?.name ?? "?"}, {r.side === "front" ? "Front" : "Back"} 9)</option>;
              })}
            </select>
          </Field>
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <StatBox label="Week" value={`Week ${round.week}`} />
          <StatBox label="Date" value={round.date} />
          <StatBox label="Par" value={par} />
          <StatBox label="Course" value={course?.name ?? "—"} />
          <StatBox label="Players" value={round.scores.length} />
          <StatBox label="Purse" value={`$${prize.purse}`} />
        </div>

        {results.length > 0 && (
          <div style={{ background: "linear-gradient(135deg, #1a5c2a, #2d8a45)", borderRadius: 10, padding: "16px 20px", marginBottom: 16, color: "#fff" }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
              🏆 WINNER{round.doublePoints && <><br /><span style={{ background: "rgba(255,255,255,0.2)", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>⚡ DOUBLE POINTS MAJOR WEEK</span></>}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{results[0].player.name}</div>
            <div style={{ fontSize: 14, opacity: 0.9, marginTop: 4 }}>
              Net: {results[0].net.toFixed(1)} &nbsp;|&nbsp; Gross: {results[0].gross} &nbsp;|&nbsp; Mod Avg: {results[0].modAvg.toFixed(2)} &nbsp;|&nbsp; Strokes: {results[0].strokes.toFixed(1)}
            </div>
          </div>
        )}

        <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, backgroundColor: "#fff" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
              <Th style={stickyTh1}>#</Th>
              <Th style={stickyTh2}>Player</Th>
              <Th>Gross</Th><Th>Mod Avg</Th><Th>Strokes</Th><Th>Net Score</Th><Th>Payout</Th>
            </tr></thead>
            <tbody>
              {results.slice(0, 4).map((r: RoundResult, i: number) => {
                const payout = prize.placements[i];
                return (
                  <tr key={r.player.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                    <td style={{ ...tdStyle, ...stickyTd1, fontWeight: 700, color: i === 0 ? "#1a5c2a" : "#333" }}>{i + 1}</td>
                    <td style={{ ...tdStyle, ...stickyTd2, fontWeight: i === 0 ? 700 : 400 }}>{r.player.name}</td>
                    <td style={tdStyle}>{r.gross}</td>
                    <td style={tdStyle}>{r.modAvg.toFixed(2)}</td>
                    <td style={tdStyle}>{r.strokes.toFixed(1)}</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: i === 0 ? "#1a5c2a" : "#333" }}>{r.net.toFixed(1)}</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: "#1a5c2a" }}>{payout ? `$${payout.amount}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
          * Strokes = (Par − Modified Avg) × 0.83, rounded to 1 decimal. Net = Gross + Strokes (strokes are negative for higher handicappers). Modified Avg updates each week based on actual scores.
        </p>

        {round.ctp && round.ctp.some(c => c.hole) && (
          <div style={{ marginTop: 16, borderTop: "2px solid #e0f0e0", paddingTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#1a5c2a", marginBottom: 8 }}>📍 Closest to the Pin</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: "1px solid #cde0cd", background: "#f5fbf5" }}>
                <Th>Hole</Th><Th>Winner</Th><Th>Payout</Th>
              </tr></thead>
              <tbody>
                {round.ctp.map((c, i) => {
                  const winner = c.winnerId ? players.find(p => String(p.id) === String(c.winnerId)) : null;
                  const ctpPayout = winner ? prize.ctpPayouts.find(cp => cp.player.id === winner.id) : null;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid #eef2ee" }}>
                      <td style={tdStyle}>Hole {c.hole || "—"}</td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: winner ? "#1a5c2a" : "#333" }}>
                        {winner ? `🏅 ${winner.name}` : "—"}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: "#1a5c2a" }}>
                        {ctpPayout && ctpPayout.amount > 0 ? `$${ctpPayout.amount}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── HISTORY TAB ──────────────────────────────────────────────
function HistoryTab({ players, rounds, courses }) {
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(() => rounds.length > 0 ? rounds[rounds.length - 1].week : null);
  if (rounds.length === 0) return <Card title="Season History"><p style={{ color: "#888" }}>No rounds entered yet.</p></Card>;

  const allResults = rounds.map((round: Round, roundIndex: number) => {
    const course = courses.find((c: Course) => c.id === round.courseId);
    const par = round.par || 36;
    const scores = round.scores.map((s: Score) => {
      const player = players.find((p: Player) => p.id === s.playerId);
      if (!player) return null;
      const modAvg = getModifiedAvgBeforeRound(player, rounds, roundIndex);
      const strokes = calcStrokes(modAvg, par);
      const net = s.gross + strokes;
      return { player, gross: s.gross, modAvg, strokes, net };
    }).filter((r): r is RoundResult => r !== null).sort((a: RoundResult, b: RoundResult) => a.net - b.net);
    return { round, scores, course, par };
  });

  const playerHistory = selectedPlayer
    ? rounds.map((round: Round, roundIndex: number) => {
        const player = players.find((p: Player) => p.id === selectedPlayer);
        const score = round.scores.find((s: Score) => s.playerId === selectedPlayer);
        if (!score || !player) return null;
        const course = courses.find((c: Course) => c.id === round.courseId);
        const par = round.par || 36;
        const modAvgBefore = getModifiedAvgBeforeRound(player, rounds, roundIndex);
        const strokes = calcStrokes(modAvgBefore, par);
        const net = score.gross + strokes;
        const modAvgAfter = calcModifiedAvg(modAvgBefore, score.gross);
        const rank = allResults[roundIndex].scores.findIndex((s: RoundResult) => s.player.id === selectedPlayer) + 1;
        return { round, gross: score.gross, modAvgBefore, modAvgAfter, strokes, net, rank, total: allResults[roundIndex].scores.length, course, par };
      }).filter(Boolean)
    : null;

  const displayedResults = allResults.filter((r: { round: Round }) => r.round.week === selectedWeek);

  return (
    <div>
      <Card title="Season History — All Rounds">
        <div style={{ marginBottom: 16 }}>
          <Field label="Select Week">
            <select value={selectedWeek ?? ""} onChange={e => setSelectedWeek(parseInt(e.target.value))} style={inputStyle}>
              {rounds.map((r: Round) => {
                const c = courses.find((x: Course) => x.id === r.courseId);
                return <option key={r.week} value={r.week}>Week {r.week} — {c?.name ?? "?"} ({r.date})</option>;
              })}
            </select>
          </Field>
        </div>
        {displayedResults.map(({ round, scores, course, par }: { round: Round; scores: RoundResult[]; course: Course | undefined; par: number }) => (
          <div key={round.week} style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#1a5c2a", marginBottom: 6 }}>
              Week {round.week} &nbsp;·&nbsp; {round.date} &nbsp;·&nbsp; {course?.name ?? "?"} ({round.side === "front" ? "Front" : "Back"} 9) &nbsp;·&nbsp; Par {par}
              {round.doublePoints && <><br /><span style={{ background: "#1a5c2a", color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>⚡ DOUBLE POINTS MAJOR WEEK</span></>}
            </div>
            <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13, backgroundColor: "#fff" }}>
                <thead><tr style={{ borderBottom: "1px solid #cde0cd", background: "#f5fbf5" }}>
                  <Th style={stickyTh1}>#</Th>
                  <Th style={stickyTh2}>Player</Th>
                  <Th>Gross</Th><Th>Mod Avg</Th><Th>Strokes</Th><Th>Net</Th>
                </tr></thead>
                <tbody>
                  {scores.map((s: RoundResult, i: number) => (
                    <tr key={s.player.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                      <td style={{ ...tdStyle, ...stickyTd1 }}>{i + 1}</td>
                      <td style={{ ...tdStyle, ...stickyTd2 }}>{s.player.name}</td>
                      <td style={tdStyle}>{s.gross}</td>
                      <td style={tdStyle}>{s.modAvg.toFixed(2)}</td>
                      <td style={tdStyle}>{s.strokes.toFixed(1)}</td>
                      <td style={{ ...tdStyle, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#1a5c2a" : "#333" }}>{s.net.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {round.ctp && round.ctp.some(c => c.hole) && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                📍 CTP: {round.ctp.filter(c => c.hole).map(c => {
                  const w = c.winnerId ? players.find(p => p.id === parseInt(c.winnerId as string) || p.id === c.winnerId) : null;
                  return `Hole ${c.hole}: ${w ? w.name : "No winner"}`;
                }).join(" · ")}
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title="Player Handicap Progression">
        <Field label="Select Player">
          <select value={selectedPlayer ?? ""} onChange={e => setSelectedPlayer(parseInt(e.target.value) || null)} style={inputStyle}>
            <option value="">— Choose a player —</option>
            {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {playerHistory && (
          <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, marginTop: 12, fontSize: 13, backgroundColor: "#fff" }}>
              <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
                <Th style={stickyTh1}>Week</Th>
                <Th>Course</Th><Th>9</Th><Th>Par</Th><Th>Gross</Th>
                <Th>Mod Avg Before</Th><Th>Mod Avg After</Th><Th>Strokes</Th>
                <Th>Net</Th><Th>Finish</Th>
              </tr></thead>
              <tbody>
                {playerHistory.map((h: any) => (
                  <tr key={h.round.week} style={{ borderBottom: "1px solid #eef2ee" }}>
                    <td style={{ ...tdStyle, ...stickyTd1 }}>Week {h.round.week}</td>
                    <td style={tdStyle}>{h.course?.name ?? "—"}</td>
                    <td style={tdStyle}>{h.round.side === "front" ? "Front" : "Back"}</td>
                    <td style={tdStyle}>{h.par}</td>
                    <td style={tdStyle}>{h.gross}</td>
                    <td style={tdStyle}>{h.modAvgBefore.toFixed(2)}</td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: h.modAvgAfter < h.modAvgBefore ? "#1a5c2a" : "#c0392b" }}>
                      {h.modAvgAfter.toFixed(2)}
                    </td>
                    <td style={tdStyle}>{h.strokes.toFixed(1)}</td>
                    <td style={tdStyle}>{h.net.toFixed(1)}</td>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{h.rank}/{h.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── STANDINGS TAB ────────────────────────────────────────────
function StandingsTab({ players, rounds }: { players: Player[]; rounds: Round[] }) {
  if (rounds.length === 0) return <Card title="CGI Cup Standings"><p style={{ color: "#888" }}>No rounds entered yet.</p></Card>;

  // Accumulate points per non-guest player across all rounds
  const playerData: Record<number, { player: Player; total: number; weeksPlayed: number; wins: number; top3s: number; weeklyPoints: Record<number, number> }> = {};
  players.filter((p: Player) => !p.guest).forEach((p: Player) => {
    playerData[p.id] = { player: p, total: 0, weeksPlayed: 0, wins: 0, top3s: 0, weeklyPoints: {} };
  });

  rounds.forEach((round: Round, roundIndex: number) => {
    const par = round.par || 36;
    const isDouble = !!round.doublePoints;

    const results = round.scores.map((s: Score) => {
      const player = players.find((p: Player) => p.id === s.playerId);
      if (!player) return null;
      const modAvg = getModifiedAvgBeforeRound(player, rounds, roundIndex);
      const strokes = calcStrokes(modAvg, par);
      const net = s.gross + strokes;
      return { player, net };
    }).filter((r): r is { player: Player; net: number } => r !== null)
      .sort((a, b) => a.net - b.net);

    results.forEach((r, i) => {
      if (r.player.guest) return;
      const rank = i + 1;
      const pts = calcPoints(rank, isDouble);
      if (!playerData[r.player.id]) {
        playerData[r.player.id] = { player: r.player, total: 0, weeksPlayed: 0, wins: 0, top3s: 0, weeklyPoints: {} };
      }
      playerData[r.player.id].total += pts;
      playerData[r.player.id].weeksPlayed += 1;
      if (rank === 1) playerData[r.player.id].wins += 1;
      if (rank <= 3) playerData[r.player.id].top3s += 1;
      playerData[r.player.id].weeklyPoints[round.week] = pts;
    });
  });

  const standings = Object.values(playerData).sort((a, b) => b.total - a.total);

  return (
    <div>
      <Card title="CGI Cup Standings">
        <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, backgroundColor: "#fff" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
              <Th style={stickyTh1}>#</Th>
              <Th style={stickyTh2}>Player</Th>
              <Th>Total Points</Th><Th>Events Played</Th><Th>Avg / Event</Th><Th>Wins</Th><Th>Top 3's</Th>
            </tr></thead>
            <tbody>
              {standings.map((s, i) => (
                <tr key={s.player.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                  <td style={{ ...tdStyle, ...stickyTd1, fontWeight: 700, color: i < 3 ? "#1a5c2a" : "#333" }}>{i + 1}</td>
                  <td style={{ ...tdStyle, ...stickyTd2, fontWeight: i === 0 ? 700 : 400 }}>{s.player.name}</td>
                  <td style={{ ...tdStyle, fontWeight: 700, color: "#1a5c2a", fontSize: 16 }}>{s.total}</td>
                  <td style={tdStyle}>{s.weeksPlayed}</td>
                  <td style={tdStyle}>{s.weeksPlayed > 0 ? (s.total / s.weeksPlayed).toFixed(1) : "—"}</td>
                  <td style={{ ...tdStyle, fontWeight: 700 }}>{s.wins}</td>
                  <td style={tdStyle}>{s.top3s}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
          * Guests are not eligible for points. ⚡ Double Points weeks multiply placement points by 2. All players who participate earn +10 points regardless of finish.
        </p>
      </Card>

      <Card title="Weekly Points Breakdown">
        <div style={{ overflowX: "auto", overscrollBehaviorX: "contain" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13, backgroundColor: "#fff" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
              <Th style={stickyTh1}>Player</Th>
              {rounds.map((r: Round) => (
                <Th key={r.week}>Wk {r.week}{r.doublePoints ? " ⚡" : ""}</Th>
              ))}
              <Th>Total</Th>
            </tr></thead>
            <tbody>
              {standings.map(s => (
                <tr key={s.player.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                  <td style={{ ...tdStyle, ...stickyTd1, fontWeight: 600 }}>{s.player.name}</td>
                  {rounds.map((r: Round) => {
                    const pts = s.weeklyPoints[r.week];
                    return (
                      <td key={r.week} style={{ ...tdStyle, color: pts !== undefined ? "#1a5c2a" : "#ccc" }}>
                        {pts !== undefined ? pts : "—"}
                      </td>
                    );
                  })}
                  <td style={{ ...tdStyle, fontWeight: 700, color: "#1a5c2a" }}>{s.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── INFO TAB ─────────────────────────────────────────────────
function InfoTab() {

  const formula = (text: string) => (
    <div style={{ background: "#f5fbf5", border: "1px solid #cde8cd", borderRadius: 6, padding: "8px 14px", fontFamily: "monospace", fontSize: 13, margin: "8px 0" }}>
      {text}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      <Card title="Overview">
        <p style={{ color: "#444", lineHeight: 1.7, margin: 0 }}>
          The CGI Cup uses a <strong>rolling Modified Average handicap system</strong> for 9-hole weekly play.
          Each week, a player's strokes are calculated from their <strong>Modified Average</strong> — a running
          average that updates automatically after every round. Net scores are used to determine
          the weekly winner, giving every player a fair chance regardless of skill level.
        </p>
      </Card>

      <Card title="Starting Average">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How is a player's starting point set?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          Each player is assigned a <strong>Starting Average</strong> before the season begins. This is their
          expected 9-hole gross score and serves as the baseline for Week 1 stroke calculations.
          It is entered manually in the Players tab.
        </p>
        {formula("Week 1 Modified Avg  =  Starting Average")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: A player with a starting average of 42 will have a Modified Avg of 42.00 going into Week 1.
        </p>
      </Card>

      <Card title="Modified Average">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How does the Modified Average update each week?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          After each round, the Modified Average updates based on how the player scored relative to their current average.
          Improvement is rewarded more aggressively than decline — a bad round only bleeds in 20%, while
          a good round moves the average to the midpoint.
        </p>
        {formula("If gross > avg  →  New Avg  =  prevAvg + 0.2 × (gross − prevAvg)")}
        {formula("If gross ≤ avg  →  New Avg  =  (prevAvg + gross) ÷ 2")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example (played worse): prevAvg 42.00, gross 46 → 42 + 0.2 × (46 − 42) = <strong>42.80</strong>
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "4px 0 0" }}>
          Example (played better): prevAvg 42.00, gross 38 → (42 + 38) ÷ 2 = <strong>40.00</strong>
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          The Modified Average used for a given week's stroke calculation is always the average <em>before</em> that round is played.
        </p>
      </Card>

      <Card title="Weekly Strokes">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How are weekly strokes calculated?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          Strokes represent the handicap adjustment applied to a player's gross score.
          Players who average above par receive negative strokes (lowering their net score).
          Players who average below par receive positive strokes (raising their net score).
          A factor of <strong>0.83</strong> is applied when the Modified Average is at or above par,
          which prevents large handicap swings and keeps competition balanced.
        </p>
        {formula("If Mod Avg ≥ Par  →  Strokes  =  ROUND((Par − Mod Avg) × 0.83, 1)")}
        {formula("If Mod Avg < Par  →  Strokes  =  ROUND(Par − Mod Avg, 1)")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: Mod Avg 42.00, Par 36 → (36 − 42) × 0.83 = <strong>−5.0 strokes</strong>
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "4px 0 0" }}>
          The par used each week is set when scores are entered and can be adjusted if a hole plays at a different par
          (e.g., hole 1 playing as par 3 instead of par 4 changes the round par from 36 to 35).
        </p>
      </Card>

      <Card title="Net Score & Winner">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How is the weekly winner determined?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          Each player's <strong>Net Score</strong> is their gross score plus their strokes (strokes are negative
          for higher-handicap players, so this effectively subtracts them).
          The player with the <strong>lowest net score</strong> wins the week.
        </p>
        {formula("Net Score  =  Gross Score  +  Strokes")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: Gross 42, Strokes −5.0 → Net = <strong>37.0</strong>
        </p>
      </Card>

      <Card title="How the Average Evolves Over the Season">
        <p style={{ color: "#444", lineHeight: 1.7, margin: 0 }}>
          The Modified Average is recalculated <strong>before each round</strong> — meaning a player's
          strokes for Week 5 are based only on their starting average plus rounds 1–4.
          Because bad rounds only raise the average by 20% of the overage, consistent improvement
          is rewarded: playing well drops the average quickly, while one bad round barely moves it up.
          This keeps handicaps fair and progressive throughout the season.
        </p>
      </Card>

      <Card title="CGI Cup Points">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How are season standings points calculated?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 12px" }}>
          Each week, players earn points based on their finishing position (net score rank) plus a flat
          participation bonus. Guest players are not eligible and earn 0 points. Some weeks are designated
          as <strong>⚡ Double Points</strong> weeks, which multiply placement points by 2.
        </p>
        {formula("Points  =  (Placement Points × Place Power)  +  10")}
        <p style={{ color: "#444", lineHeight: 1.7, margin: "8px 0 12px" }}>
          <strong>Place Power</strong> is 1× for a regular week and 2× for a Double Points week.<br />
          The <strong>+10 participation bonus</strong> is awarded to every eligible player who plays, regardless of finish.
        </p>
        <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700, color: "#555" }}>Placement Points by Finishing Position:</p>
        <table style={{ borderCollapse: "collapse", fontSize: 13, marginBottom: 8, marginLeft: "auto", marginRight: "auto" }}>
          <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
            <th style={{ textAlign: "center", padding: "6px 16px 6px 10px", fontWeight: 700, color: "#555" }}>Finish</th>
            <th style={{ textAlign: "center", padding: "6px 16px 6px 10px", fontWeight: 700, color: "#555" }}>Points</th>
            <th style={{ textAlign: "center", padding: "6px 16px 6px 10px", fontWeight: 700, color: "#555" }}>Finish</th>
            <th style={{ textAlign: "center", padding: "6px 10px 6px 10px", fontWeight: 700, color: "#555" }}>Points</th>
          </tr></thead>
          <tbody>
            {[[1,120],[2,90],[3,65],[4,45],[5,30]].map(([pos, pts], i) => (
              <tr key={i} style={{ borderBottom: "1px solid #eef2ee" }}>
                <td style={{ padding: "5px 16px 5px 10px", fontWeight: 600, textAlign: "center" }}>{pos === 1 ? "1st" : pos === 2 ? "2nd" : pos === 3 ? "3rd" : `${pos}th`}</td>
                <td style={{ padding: "5px 16px 5px 10px", color: "#1a5c2a", fontWeight: 700, textAlign: "center" }}>{pts}</td>
                <td style={{ padding: "5px 16px 5px 10px", fontWeight: 600, textAlign: "center" }}>{`${pos + 5}th`}</td>
                <td style={{ padding: "5px 10px 5px 10px", color: "#1a5c2a", fontWeight: 700, textAlign: "center" }}>{[20,16,12,9,6][i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: "#666", fontSize: 13, margin: "4px 0 0" }}>
          Players finishing 11th or lower receive only the +10 participation bonus.
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example (regular week, 1st place): 120 × 1 + 10 = <strong>130 points</strong><br />
          Example (double points week, 3rd place): 65 × 2 + 10 = <strong>140 points</strong>
        </p>
      </Card>

    </div>
  );
}

// ── SHARED COMPONENTS ────────────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.07)", padding: "20px", marginBottom: 20 }}>
      {title && <h2 style={{ margin: "0 0 16px", fontSize: 17, color: "#1a5c2a", borderBottom: "2px solid #e0f0e0", paddingBottom: 8 }}>{title}</h2>}
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label style={{ fontSize: 12, fontWeight: 600, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</label>{children}</div>;
}
function Th({ children, style = {} }) {
  return <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 0.3, ...style }}>{children}</th>;
}
function StatBox({ label, value }) {
  return (
    <div style={{ background: "#f5fbf5", border: "1px solid #cde8cd", borderRadius: 8, padding: "10px 16px", minWidth: 80 }}>
      <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1a5c2a", marginTop: 2 }}>{value}</div>
    </div>
  );
}
const tdStyle = { padding: "9px 10px", fontSize: 14, verticalAlign: "middle", textAlign: "left" as const };
const stickyTh1 = { position: "sticky" as const, left: 0, zIndex: 20, background: "#f5fbf5", backgroundColor: "#f5fbf5", minWidth: 44 };
const stickyTh2 = { position: "sticky" as const, left: 44, zIndex: 20, background: "#f5fbf5", backgroundColor: "#f5fbf5", paddingRight: 16 };
const stickyTd1 = { position: "sticky" as const, left: 0, zIndex: 10, background: "#fff", backgroundColor: "#fff", minWidth: 44 };
const stickyTd2 = { position: "sticky" as const, left: 44, zIndex: 10, background: "#fff", backgroundColor: "#fff", paddingRight: 16 };
const inputStyle = { padding: "7px 10px", borderRadius: 6, border: "1px solid #ccc", fontSize: 14, outline: "none" };
const btnStyle = (bg) => ({ background: bg, color: "#fff", border: "none", borderRadius: 7, padding: "9px 18px", cursor: "pointer", fontWeight: 600, fontSize: 14 });
const btnSmall = (bg) => ({ background: bg, color: "#fff", border: "none", borderRadius: 5, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600 });
