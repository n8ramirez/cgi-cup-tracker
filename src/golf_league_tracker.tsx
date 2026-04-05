import { useState, useEffect, useCallback } from "react";
import { db } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

// ── TYPES ─────────────────────────────────────────────────────
interface SideData { par: string; rating: string; slope: string; }
interface Course {
  id: number; name: string;
  ratingMode: "18hole" | "9hole";
  // 18-hole mode
  par18?: string; rating18?: string; slope18?: string;
  // 9-hole mode
  front?: SideData; back?: SideData;
}
interface Player { id: number; name: string; startingAvg: number; }
interface Score { playerId: number; gross: number; }
interface CtpEntry { hole: string; winnerId: string | null; }
interface Round { id: number; week: number; date: string; courseId: number; side: "front" | "back"; par: number; scores: Score[]; ctp: CtpEntry[]; }

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

// ── GHIN HANDICAP ────────────────────────────────────────────
function getCourseSide(course: Course, _side: "front" | "back"): SideData {
  if (course.ratingMode === "18hole") {
    const par9 = course.par18 ? String(Math.round(parseFloat(course.par18) / 2 * 10) / 10) : "";
    const rating9 = course.rating18 ? String(Math.round(parseFloat(course.rating18) / 2 * 10) / 10) : "";
    return { par: par9, rating: rating9, slope: course.slope18 ?? "" };
  }
  return (_side === "front" ? course.front : course.back) ?? { par: "", rating: "", slope: "" };
}

function calcDifferential(gross: number, rating: number, slope: number): number {
  return Math.round((113 / slope) * (gross - rating) * 100) / 100;
}

function getDiffLookup(n: number): { count: number; adj: number } {
  if (n <= 0)   return { count: 0, adj: 0 };
  if (n <= 2)   return { count: 1, adj: 0 };
  if (n === 3)  return { count: 1, adj: -2.0 };
  if (n === 4)  return { count: 1, adj: -1.0 };
  if (n === 5)  return { count: 1, adj: -0.5 };
  if (n <= 8)   return { count: 2, adj: 0 };
  if (n <= 11)  return { count: 3, adj: 0 };
  if (n <= 14)  return { count: 4, adj: 0 };
  if (n === 15) return { count: 5, adj: 0 };
  if (n <= 17)  return { count: 6, adj: 0 };
  if (n <= 19)  return { count: 7, adj: 0 };
  return { count: 8, adj: 0 };
}

function calcHandicapIndex(diffs: number[]): number | null {
  if (diffs.length === 0) return null;
  const sorted = [...diffs].sort((a, b) => a - b);
  const { count, adj } = getDiffLookup(sorted.length);
  if (count === 0) return null;
  const best = sorted.slice(0, count);
  const avg = best.reduce((s, d) => s + d, 0) / count;
  return Math.round((avg + adj) * 0.96 * 10) / 10;
}

function calcCourseHandicap(hi: number, slope: number, rating: number, par: number): number {
  return Math.round((hi * (slope / 113) + (rating - par)) * 10) / 10;
}

function getStartingDiff(player: Player): number {
  return parseFloat(String(player.startingAvg)) - 36;
}

function getDifferentialsBeforeRound(player: Player, rounds: Round[], courses: Course[], roundIndex: number): number[] {
  const diffs: number[] = [];
  diffs.push(getStartingDiff(player));
  for (let i = 0; i < roundIndex; i++) {
    const round = rounds[i];
    const score = round.scores.find(s => s.playerId === player.id);
    if (!score || score.gross === undefined || isNaN(score.gross)) continue;
    if (!round.courseId || !round.side) continue;
    const course = courses.find(c => c.id === round.courseId);
    if (!course) continue;
    const side = getCourseSide(course, round.side);
    if (!side?.rating || !side?.slope) continue;
    diffs.push(calcDifferential(score.gross, parseFloat(side.rating), parseFloat(side.slope)));
  }
  return diffs;
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

// ── APP ──────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("players");
  const [players, setPlayersRaw] = useState([]);
  const [rounds, setRoundsRaw] = useState([]);
  const [courses, setCoursesRaw] = useState([]);
  const [loaded, setLoaded] = useState(false);

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

  const tabs = ["players", "courses", "scores", "leaderboard", "history", "info"] as const;
  const tabLabels: Record<typeof tabs[number], string> = { players: "👤 Players", courses: "🗺️ Courses", scores: "📝 Enter Scores", leaderboard: "🏆 Leaderboard", history: "📋 Season History", info: "ℹ️ How It Works" };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#f0f4f0", minHeight: "100vh", paddingBottom: 40 }}>
      <div style={{ background: "linear-gradient(135deg, #1a5c2a, #2d8a45)", color: "#fff", padding: "18px 24px 0", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>⛳ CGI CUP</h1>
        <div style={{ display: "flex", gap: 4, marginTop: 14, flexWrap: "wrap" }}>
          {tabs.map(t => (
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
        {tab === "info"        && <InfoTab />}
      </div>
    </div>
  );
}

// ── COURSES TAB ──────────────────────────────────────────────
const emptyCourseForm = () => ({ name: "", par18: "", rating18: "", slope18: "" });
type CourseForm = ReturnType<typeof emptyCourseForm>;

function CourseFormFields({ form, patch }: { form: CourseForm; patch: (p: Partial<CourseForm>) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Field label="18-Hole Par">
        <input type="number" value={form.par18} onChange={e => patch({ par18: e.target.value })} placeholder="72" style={{ ...inputStyle, width: 70 }} />
      </Field>
      <Field label="18-Hole Course Rating">
        <input type="number" step="0.1" value={form.rating18} onChange={e => patch({ rating18: e.target.value })} placeholder="70.2" style={{ ...inputStyle, width: 110 }} />
      </Field>
      <Field label="Slope">
        <input type="number" value={form.slope18} onChange={e => patch({ slope18: e.target.value })} placeholder="128" style={{ ...inputStyle, width: 80 }} />
      </Field>
    </div>
  );
}

function CoursesTab({ courses, setCourses }: { courses: Course[]; setCourses: (u: (prev: Course[]) => Course[]) => void }) {
  const [form, setForm] = useState<CourseForm>(emptyCourseForm());
  const [editId, setEditId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<Course | null>(null);

  const patch = (p: Partial<CourseForm>) => setForm(prev => ({ ...prev, ...p }));

  const addCourse = () => {
    if (!form.name.trim()) return;
    setCourses(prev => [...prev, { id: Date.now(), name: form.name.trim(), ratingMode: "18hole", par18: form.par18, rating18: form.rating18, slope18: form.slope18 }]);
    setForm(emptyCourseForm());
  };

  const saveEdit = (id: number) => {
    setCourses(prev => prev.map(c => c.id === id ? { ...c, name: form.name.trim(), par18: form.par18, rating18: form.rating18, slope18: form.slope18 } : c));
    setEditId(null);
  };

  const startEdit = (c: Course) => {
    setEditId(c.id);
    setForm({ name: c.name, par18: c.par18 ?? "", rating18: c.rating18 ?? "", slope18: c.slope18 ?? "" });
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
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Course Name">
            <input value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="e.g. Pebble Beach GC" style={{ ...inputStyle, maxWidth: 300 }} />
          </Field>
          <CourseFormFields form={form} patch={patch} />
          {form.par18 && form.rating18 && (
            <div style={{ fontSize: 12, color: "#888" }}>
              9-hole values derived — Par: {Math.round(parseFloat(form.par18) / 2 * 10) / 10}, Rating: {Math.round(parseFloat(form.rating18) / 2 * 10) / 10}, Slope: {form.slope18}
            </div>
          )}
          <div><button onClick={addCourse} style={btnStyle("#1a5c2a")}>Add Course</button></div>
        </div>
      </Card>

      <Card title={`Courses (${courses.length})`}>
        {courses.length === 0 && <p style={{ color: "#888", margin: 0 }}>No courses yet. Add one above.</p>}
        {courses.map(c => {
          const derived = getCourseSide(c, "front");
          return (
            <div key={c.id} style={{ border: "1px solid #e0eee0", borderRadius: 8, padding: "14px 16px", marginBottom: 12 }}>
              {editId === c.id ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label="Course Name">
                    <input value={form.name} onChange={e => patch({ name: e.target.value })} style={{ ...inputStyle, maxWidth: 300 }} />
                  </Field>
                  <CourseFormFields form={form} patch={patch} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => saveEdit(c.id)} style={btnSmall("#1a5c2a")}>Save</button>
                    <button onClick={() => setEditId(null)} style={btnSmall("#888")}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#1a5c2a", marginBottom: 8 }}>{c.name}</div>
                  <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
                    <thead><tr style={{ borderBottom: "1px solid #e0eee0" }}>
                      <Th>18-Hole Par</Th><Th>18-Hole Rating</Th><Th>Slope</Th><Th>9-Hole Par</Th><Th>9-Hole Rating</Th>
                    </tr></thead>
                    <tbody>
                      <tr>
                        <td style={tdStyle}>{c.par18 ?? "—"}</td>
                        <td style={tdStyle}>{c.rating18 ?? "—"}</td>
                        <td style={tdStyle}>{c.slope18 ?? "—"}</td>
                        <td style={tdStyle}>{derived.par || "—"}</td>
                        <td style={tdStyle}>{derived.rating || "—"}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button onClick={() => startEdit(c)} style={btnSmall("#2d6a8a")}>Edit</button>
                    <button onClick={() => setConfirm(c)} style={btnSmall("#c0392b")}>Remove</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ── PLAYERS TAB ──────────────────────────────────────────────
function PlayersTab({ players, setPlayers }) {
  const [name, setName] = useState("");
  const [avg, setAvg] = useState("");
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editAvg, setEditAvg] = useState("");
  const [confirm, setConfirm] = useState(null);

  const addPlayer = () => {
    if (!name.trim() || !avg) return;
    setPlayers(prev => [...prev, { id: Date.now(), name: name.trim(), startingAvg: parseFloat(avg) }]);
    setName(""); setAvg("");
  };

  const saveEdit = (id) => {
    setPlayers(prev => prev.map(p => p.id === id
      ? { ...p, name: editName.trim(), startingAvg: parseFloat(editAvg) }
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
                      : p.name}
                  </td>
                  <td style={tdStyle}>
                    {editId === p.id
                      ? <input type="number" value={editAvg} onChange={e => setEditAvg(e.target.value)} style={{ ...inputStyle, width: 80 }} />
                      : p.startingAvg}
                  </td>
                  <td style={tdStyle}>
                    {editId === p.id
                      ? <><button onClick={() => saveEdit(p.id)} style={btnSmall("#1a5c2a")}>Save</button>{" "}<button onClick={() => setEditId(null)} style={btnSmall("#888")}>Cancel</button></>
                      : <><button onClick={() => { setEditId(p.id); setEditName(p.name); setEditAvg(p.startingAvg); }} style={btnSmall("#2d6a8a")}>Edit</button>{" "}
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
  const [confirm, setConfirm] = useState(null);

  const existingRound = rounds.find(r => r.week === weekNum);
  const selectedCourse = courses.find(c => c.id === parseInt(courseId));
  const selectedSideData = selectedCourse ? getCourseSide(selectedCourse, side) : null;

  // Default par from course when course/side changes (new rounds only)
  useEffect(() => {
    if (!existingRound && selectedSideData?.par) setPar(selectedSideData.par);
  }, [courseId, side]);

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
    } else {
      setParticipating({}); setGrossScores({});
      setCtpHoles(Array.from({ length: ctpCount }, () => ({ hole: "", winnerId: "" })));
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
    const roundPar = parseFloat(par) > 0 ? parseFloat(par) : parseFloat(selectedSideData?.par ?? "0");
    const round = { id: existingRound?.id || Date.now(), week: weekNum, date, courseId: parseInt(courseId), side, par: roundPar, scores, ctp };
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

        {selectedSideData && (
          <div style={{ background: "#f5fbf5", border: "1px solid #cde8cd", borderRadius: 6, padding: "8px 14px", marginBottom: 12, fontSize: 13, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field label="Par (editable)">
              <input type="number" value={par} onChange={e => setPar(e.target.value)} style={{ ...inputStyle, width: 70, fontSize: 13 }} />
            </Field>
            <span style={{ alignSelf: "center" }}><strong>Rating:</strong> {selectedSideData.rating}</span>
            <span style={{ alignSelf: "center" }}><strong>Slope:</strong> {selectedSideData.slope}</span>
          </div>
        )}

        {courses.length === 0 && <p style={{ color: "#c0392b", fontSize: 13 }}>⚠️ Add a course in the Courses tab first.</p>}
        {existingRound && <div style={{ background: "#fff8e1", border: "1px solid #f0c040", borderRadius: 6, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>⚠️ Editing existing Week {weekNum} scores.</div>}
        {players.length === 0 && <p style={{ color: "#888" }}>Add players first in the Players tab.</p>}

        {players.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0" }}>
              <Th>Playing?</Th><Th>Player</Th><Th>Gross Score</Th>
            </tr></thead>
            <tbody>
              {players.map(p => (
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
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
              <Th>CTP #</Th><Th>Hole Number</Th><Th>Winner</Th>
            </tr></thead>
            <tbody>
              {ctpHoles.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #eef2ee" }}>
                  <td style={tdStyle}>CTP {i + 1}</td>
                  <td style={tdStyle}>
                    <input type="number" value={c.hole} onChange={e => updateCtp(i, "hole", e.target.value)} placeholder="e.g. 5" style={{ ...inputStyle, width: 80 }} />
                  </td>
                  <td style={tdStyle}>
                    <select value={c.winnerId} onChange={e => updateCtp(i, "winnerId", e.target.value)} style={inputStyle}>
                      <option value="">— No winner / N/A —</option>
                      {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {players.length > 0 && <button onClick={saveRound} style={{ ...btnStyle("#1a5c2a"), marginTop: 16 }}>💾 Save Week {weekNum} Scores</button>}
      </Card>

      {rounds.length > 0 && (
        <Card title="Saved Rounds">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0" }}>
              <Th>Week</Th><Th>Date</Th><Th>Course</Th><Th>9</Th><Th>Players</Th><Th>Actions</Th>
            </tr></thead>
            <tbody>
              {rounds.map(r => {
                const course = courses.find(c => c.id === r.courseId);
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                    <td style={tdStyle}>Week {r.week}</td>
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
  const sideData = course ? getCourseSide(course, round.side) : null;

  const results = round.scores.map(s => {
    const player = players.find(p => p.id === s.playerId);
    if (!player || !sideData) return null;
    const diffs = getDifferentialsBeforeRound(player, rounds, courses, roundIndex);
    const hi = calcHandicapIndex(diffs);
    const ch = hi !== null ? calcCourseHandicap(hi, parseFloat(sideData.slope), parseFloat(sideData.rating), round.par || parseFloat(sideData.par)) : null;
    const net = ch !== null ? s.gross - ch : null;
    const diff = calcDifferential(s.gross, parseFloat(sideData.rating), parseFloat(sideData.slope));
    return { player, gross: s.gross, hi, ch, net, diff };
  }).filter(r => r && r.net !== null).sort((a, b) => a.net - b.net);

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
          {sideData && <StatBox label="Par" value={round.par || sideData.par} />}
          {sideData && <StatBox label="Rating" value={sideData.rating} />}
          {sideData && <StatBox label="Slope" value={sideData.slope} />}
          <StatBox label="Players" value={round.scores.length} />
        </div>

        {results.length > 0 && (
          <div style={{ background: "linear-gradient(135deg, #1a5c2a, #2d8a45)", borderRadius: 10, padding: "16px 20px", marginBottom: 16, color: "#fff" }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>🏆 WINNER</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{results[0].player.name}</div>
            <div style={{ fontSize: 14, opacity: 0.9, marginTop: 4 }}>
              Net: {results[0].net?.toFixed(1)} &nbsp;|&nbsp; Gross: {results[0].gross} &nbsp;|&nbsp; HI: {results[0].hi?.toFixed(1)} &nbsp;|&nbsp; Course HCP: {results[0].ch}
            </div>
          </div>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
            <Th>#</Th><Th>Player</Th><Th>Gross</Th><Th>Differential</Th><Th>Handicap Index</Th><Th>Course HCP</Th><Th>Net Score</Th>
          </tr></thead>
          <tbody>
            {results.slice(0, 4).map((r: typeof results[number], i: number) => (
              <tr key={r.player.id} style={{ borderBottom: "1px solid #eef2ee", background: i === 0 ? "#f0faf0" : "transparent" }}>
                <td style={{ ...tdStyle, fontWeight: 700, color: i === 0 ? "#1a5c2a" : "#333" }}>{i + 1}</td>
                <td style={{ ...tdStyle, fontWeight: i === 0 ? 700 : 400 }}>{r.player.name}</td>
                <td style={tdStyle}>{r.gross}</td>
                <td style={tdStyle}>{r.diff.toFixed(1)}</td>
                <td style={tdStyle}>{r.hi !== null ? r.hi.toFixed(1) : "—"}</td>
                <td style={tdStyle}>{r.ch !== null ? r.ch : "—"}</td>
                <td style={{ ...tdStyle, fontWeight: 700, color: i === 0 ? "#1a5c2a" : "#333" }}>{r.net?.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
          * Handicap Index uses USGA differential method (best N of available × 0.96). Net = Gross − Course Handicap.
        </p>

        {round.ctp && round.ctp.some(c => c.hole) && (
          <div style={{ marginTop: 16, borderTop: "2px solid #e0f0e0", paddingTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#1a5c2a", marginBottom: 8 }}>📍 Closest to the Pin</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: "1px solid #cde0cd", background: "#f5fbf5" }}>
                <Th>Hole</Th><Th>Winner</Th>
              </tr></thead>
              <tbody>
                {round.ctp.map((c, i) => {
                  const winner = c.winnerId ? players.find(p => p.id === parseInt(c.winnerId) || p.id === c.winnerId) : null;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid #eef2ee" }}>
                      <td style={tdStyle}>Hole {c.hole || "—"}</td>
                      <td style={{ ...tdStyle, fontWeight: winner ? 700 : 400, color: winner ? "#1a5c2a" : "#999" }}>
                        {winner ? `🏅 ${winner.name}` : "No winner entered"}
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
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);

  if (rounds.length === 0) return <Card title="Season History"><p style={{ color: "#888" }}>No rounds entered yet.</p></Card>;

  const allResults = rounds.map((round, roundIndex) => {
    const course = courses.find(c => c.id === round.courseId);
    const sideData = course ? getCourseSide(course, round.side) : null;
    const scores = round.scores.map(s => {
      const player = players.find(p => p.id === s.playerId);
      if (!player || !sideData) return null;
      const diffs = getDifferentialsBeforeRound(player, rounds, courses, roundIndex);
      const hi = calcHandicapIndex(diffs);
      const ch = hi !== null ? calcCourseHandicap(hi, parseFloat(sideData.slope), parseFloat(sideData.rating), round.par || parseFloat(sideData.par)) : null;
      const net = ch !== null ? s.gross - ch : null;
      return { player, gross: s.gross, hi, ch, net };
    }).filter(r => r && r.net !== null).sort((a, b) => a.net - b.net);
    return { round, scores, course, sideData };
  });

  const playerHistory = selectedPlayer
    ? rounds.map((round, roundIndex) => {
        const player = players.find(p => p.id === selectedPlayer);
        const score = round.scores.find(s => s.playerId === selectedPlayer);
        if (!score || !player) return null;
        const course = courses.find(c => c.id === round.courseId);
        const sideData = course ? getCourseSide(course, round.side) : null;
        if (!sideData) return null;
        const diffsBefore = getDifferentialsBeforeRound(player, rounds, courses, roundIndex);
        const hiBefore = calcHandicapIndex(diffsBefore);
        const ch = hiBefore !== null ? calcCourseHandicap(hiBefore, parseFloat(sideData.slope), parseFloat(sideData.rating), round.par || parseFloat(sideData.par)) : null;
        const net = ch !== null ? score.gross - ch : null;
        const diff = calcDifferential(score.gross, parseFloat(sideData.rating), parseFloat(sideData.slope));
        const hiAfter = calcHandicapIndex([...diffsBefore, diff]);
        const rank = allResults[roundIndex].scores.findIndex(s => s.player.id === selectedPlayer) + 1;
        return { round, gross: score.gross, hiBefore, hiAfter, ch, net, diff, rank, total: allResults[roundIndex].scores.length, course, sideData };
      }).filter(Boolean)
    : null;

  const displayedResults = selectedWeek !== null ? allResults.filter((r: { round: Round }) => r.round.week === selectedWeek) : allResults;

  return (
    <div>
      <Card title="Season History — All Rounds">
        <div style={{ marginBottom: 16 }}>
          <Field label="Select Week">
            <select value={selectedWeek ?? ""} onChange={e => setSelectedWeek(e.target.value ? parseInt(e.target.value) : null)} style={inputStyle}>
              <option value="">— All Weeks —</option>
              {rounds.map((r: Round) => {
                const c = courses.find((x: Course) => x.id === r.courseId);
                return <option key={r.week} value={r.week}>Week {r.week} — {c?.name ?? "?"} ({r.date})</option>;
              })}
            </select>
          </Field>
        </div>
        {displayedResults.map(({ round, scores, course, sideData }: { round: Round; scores: { player: Player; gross: number; hi: number | null; ch: number | null; net: number | null }[]; course: Course | undefined; sideData: SideData | null }) => (
          <div key={round.week} style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#1a5c2a", marginBottom: 6 }}>
              Week {round.week} &nbsp;·&nbsp; {round.date} &nbsp;·&nbsp; {course?.name ?? "?"} ({round.side === "front" ? "Front" : "Back"} 9) &nbsp;·&nbsp; Par {round.par || (sideData?.par ?? "?")}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: "1px solid #cde0cd", background: "#f5fbf5" }}>
                <Th>#</Th><Th>Player</Th><Th>Gross</Th><Th>HI</Th><Th>Course HCP</Th><Th>Net</Th>
              </tr></thead>
              <tbody>
                {scores.map((s, i) => (
                  <tr key={s.player.id} style={{ borderBottom: "1px solid #eef2ee" }}>
                    <td style={tdStyle}>{i + 1}</td>
                    <td style={tdStyle}>{s.player.name}</td>
                    <td style={tdStyle}>{s.gross}</td>
                    <td style={tdStyle}>{s.hi !== null ? s.hi.toFixed(1) : "—"}</td>
                    <td style={tdStyle}>{s.ch !== null ? s.ch : "—"}</td>
                    <td style={{ ...tdStyle, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#1a5c2a" : "#333" }}>{s.net}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 13 }}>
            <thead><tr style={{ borderBottom: "2px solid #e0e8e0", background: "#f5fbf5" }}>
              <Th>Week</Th><Th>Course</Th><Th>9</Th><Th>Par</Th><Th>Gross</Th><Th>Differential</Th><Th>HI Before</Th><Th>HI After</Th><Th>Course HCP</Th><Th>Net</Th><Th>Finish</Th>
            </tr></thead>
            <tbody>
              {playerHistory.map(h => (
                <tr key={h.round.week} style={{ borderBottom: "1px solid #eef2ee" }}>
                  <td style={tdStyle}>Week {h.round.week}</td>
                  <td style={tdStyle}>{h.course?.name ?? "—"}</td>
                  <td style={tdStyle}>{h.round.side === "front" ? "Front" : "Back"}</td>
                  <td style={tdStyle}>{h.round.par || h.sideData?.par || "—"}</td>
                  <td style={tdStyle}>{h.gross}</td>
                  <td style={tdStyle}>{h.diff.toFixed(1)}</td>
                  <td style={tdStyle}>{h.hiBefore !== null ? h.hiBefore.toFixed(1) : "—"}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, color: h.hiAfter !== null && h.hiBefore !== null && h.hiAfter < h.hiBefore ? "#1a5c2a" : "#c0392b" }}>
                    {h.hiAfter !== null ? h.hiAfter.toFixed(1) : "—"}
                  </td>
                  <td style={tdStyle}>{h.ch !== null ? h.ch : "—"}</td>
                  <td style={tdStyle}>{h.net !== null ? h.net : "—"}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{h.rank}/{h.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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

  const lookup = [
    [1, 2, 1], [3, 3, 1], [4, 4, 1], [5, 5, 1],
    [6, 8, 2], [9, 11, 3], [12, 14, 4], [15, 15, 5],
    [16, 17, 6], [18, 19, 7], [20, 20, 8],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      <Card title="Overview">
        <p style={{ color: "#444", lineHeight: 1.7, margin: 0 }}>
          The CGI Cup uses a <strong>USGA-based handicap system</strong> adapted for 9-hole weekly play.
          Each week, players receive a <strong>Course Handicap</strong> calculated from their running
          <strong> Handicap Index</strong>, which improves automatically as the season progresses.
          Net scores are used to determine the weekly winner, giving every player a fair chance
          regardless of skill level.
        </p>
      </Card>

      <Card title="Starting Handicap">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How is a player's first Handicap Index set?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          Before a player has any league rounds, their starting Handicap Index is seeded from their
          9-hole average score using a simplified differential against a baseline par of 36:
        </p>
        {formula("Starting Differential  =  Starting Avg  −  36")}
        {formula("Starting Handicap Index  =  Starting Differential  ×  0.96")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: A player who averages 42 per 9 holes → Differential = 42 − 36 = 6.0 → HI = 5.8
        </p>
      </Card>

      <Card title="Weekly Score Differential">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How is each round's differential calculated?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          After each round, a <strong>Score Differential</strong> is calculated using the course's
          official rating and slope. This measures how a player performed relative to the difficulty
          of the course that day.
        </p>
        {formula("Score Differential  =  (113 ÷ Slope)  ×  (Gross Score − Course Rating)")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: Gross 40, Course Rating 35.1, Slope 120 → (113 ÷ 120) × (40 − 35.1) = <strong>4.6</strong>
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "4px 0 0" }}>
          Note: Course Rating and Slope are derived from the 18-hole values entered in the Courses tab
          (each 9-hole value = 18-hole value ÷ 2 for rating; slope remains the same).
        </p>
      </Card>

      <Card title="Handicap Index">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How does the Handicap Index update each week?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          The Handicap Index is recalculated before each round using all differentials accumulated
          so far (including the starting seed). The <strong>best (lowest) differentials</strong> are
          selected based on how many rounds have been played, then averaged and multiplied by 0.96.
        </p>
        {formula("Handicap Index  =  Average of best N differentials  ×  0.96")}
        <p style={{ color: "#555", fontSize: 13, fontWeight: 600, margin: "12px 0 6px" }}>How many differentials are used (N):</p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f5fbf5", borderBottom: "2px solid #e0e8e0" }}>
              <Th>Differentials Available</Th><Th>Best N Used</Th>
            </tr>
          </thead>
          <tbody>
            {lookup.map(([min, max, n]) => (
              <tr key={min} style={{ borderBottom: "1px solid #eef2ee" }}>
                <td style={tdStyle}>{min === max ? min : `${min} – ${max}`}</td>
                <td style={tdStyle}>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: "#666", fontSize: 13, margin: "10px 0 0" }}>
          With 3–5 differentials, a small adjustment is also applied (−2.0, −1.0, or −0.5)
          to account for limited data early in the season.
        </p>
      </Card>

      <Card title="Course Handicap">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How is the weekly Course Handicap determined?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          The Handicap Index is converted into a <strong>Course Handicap</strong> specific to the
          course and 9 holes being played that week. This accounts for the difficulty of the
          particular course relative to par.
        </p>
        {formula("Course Handicap  =  HI × (Slope ÷ 113)  +  (Course Rating − Par)")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: HI 5.8, Slope 120, Rating 35.1, Par 36 → 5.8 × (120 ÷ 113) + (35.1 − 36) = <strong>5.3</strong>
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "4px 0 0" }}>
          The par used each week is set when scores are entered and can be adjusted if a hole
          plays at a different par (e.g., hole 1 playing as par 3 vs par 4).
        </p>
      </Card>

      <Card title="Net Score & Winner">
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1a5c2a" }}>How is the weekly winner determined?</p>
        <p style={{ color: "#444", lineHeight: 1.7, margin: "0 0 8px" }}>
          Each player's <strong>Net Score</strong> is their gross score minus their Course Handicap.
          The player with the <strong>lowest net score</strong> wins the week.
        </p>
        {formula("Net Score  =  Gross Score  −  Course Handicap")}
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          Example: Gross 40, Course Handicap 5.3 → Net = <strong>34.7</strong>
        </p>
      </Card>

      <Card title="How the Handicap Evolves Over the Season">
        <p style={{ color: "#444", lineHeight: 1.7, margin: 0 }}>
          The Handicap Index is recalculated <strong>before each round</strong> — meaning a player's
          handicap for Week 5 is based only on their starting seed plus rounds 1–4.
          As more rounds are played, the index becomes more accurate because it draws from
          more real data and fewer best-differentials are needed to represent true ability.
          A strong round (low differential) will lower the HI; a poor round may not raise it
          much since only the <em>best</em> differentials are used. This rewards consistent improvement.
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
function Th({ children }) {
  return <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 0.3 }}>{children}</th>;
}
function StatBox({ label, value }) {
  return (
    <div style={{ background: "#f5fbf5", border: "1px solid #cde8cd", borderRadius: 8, padding: "10px 16px", minWidth: 80 }}>
      <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1a5c2a", marginTop: 2 }}>{value}</div>
    </div>
  );
}
const tdStyle = { padding: "9px 10px", fontSize: 14, verticalAlign: "middle" };
const inputStyle = { padding: "7px 10px", borderRadius: 6, border: "1px solid #ccc", fontSize: 14, outline: "none" };
const btnStyle = (bg) => ({ background: bg, color: "#fff", border: "none", borderRadius: 7, padding: "9px 18px", cursor: "pointer", fontWeight: 600, fontSize: 14 });
const btnSmall = (bg) => ({ background: bg, color: "#fff", border: "none", borderRadius: 5, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600 });
