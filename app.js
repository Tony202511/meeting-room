import { db } from "./firebase.js";
import {
    collection,
    getDocs,
    doc,
    getDoc,
    setDoc,
    addDoc,
    deleteDoc,
    updateDoc,
    query,
    where,
    writeBatch
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── STATE ──────────────────────────────────────────────────
let selectedRoomId   = null;
let selectedRoomName = null;
let currentUserId    = null;
let currentUserRole  = null;
let selectedCells    = [];
let roomsCache       = [];
let editingRecurringId = null;  // 수정 중인 정기회의 ID (null=신규)

// ── 캐시 ───────────────────────────────────────────────────
const reservationsByRoom = {};  // { roomId: [...] }  룸별 예약 캐시
let recurringCache       = [];  // 정기 회의 전체 (데이터 적음)
let usersCache           = [];  // 사용자 전체
let projectsCache        = [];  // 프로젝트 전체

// 현재 선택된 룸의 예약 배열 반환 (없으면 빈 배열)
function getRoomReservations() { return reservationsByRoom[selectedRoomId] || []; }
// 현재 선택된 룸의 예약 배열 교체
function setRoomReservations(arr) { reservationsByRoom[selectedRoomId] = arr; }

const WEEK  = ["일","월","화","수","목","금","토"];
const HOURS = [
    "09:00","09:30","10:00","10:30","11:00","11:30",
    "12:00","12:30","13:00","13:30","14:00","14:30",
    "15:00","15:30","16:00","16:30","17:00","17:30"
];
const DEPT_ORDER = ["에너지부문","에너지1부","에너지2부","에너지3부","기전부","사업전략부"];

function sortDepts(deptSet) {
    const sorted = DEPT_ORDER.filter(d => deptSet.has(d));
    const rest   = [...deptSet].filter(d => !DEPT_ORDER.includes(d)).sort((a,b) => a.localeCompare(b,"ko"));
    return [...sorted, ...rest];
}

// ── LOGIN ──────────────────────────────────────────────────
document.getElementById("loginBtn").addEventListener("click", async () => {
    const empNo = document.getElementById("empNo").value.trim();
    const pw    = document.getElementById("loginPw").value.trim();

    if (!empNo) { alert("사번을 입력하세요"); return; }
    if (!pw)    { alert("비밀번호를 입력하세요"); return; }

    const docSnap = await getDoc(doc(db, "users", empNo));
    if (!docSnap.exists()) { alert("존재하지 않는 사번입니다."); return; }

    const user = docSnap.data();
    const storedPw = user.password ?? empNo;
    if (pw !== storedPw) { alert("비밀번호가 올바르지 않습니다."); return; }

    currentUserId   = empNo;
    currentUserRole = user.role;

    document.getElementById("loginArea").style.display  = "none";
    document.getElementById("mainArea").style.display   = "block";
    document.getElementById("logoutBtn").style.display  = "inline-block";
    document.getElementById("welcome").innerText        = user.name + "님 환영합니다";

    if (user.role !== "admin") {
        document.getElementById("adminArea").style.display = "none";
    }
    if (!user.password) openPwPopup();

    // 로그인 시 1회: 사용자·프로젝트·정기회의 캐시
    const [uSnap, pSnap, rSnap] = await Promise.all([
        getDocs(collection(db, "users")),
        getDocs(collection(db, "projects")),
        getDocs(collection(db, "recurringMeetings"))
    ]);
    usersCache     = uSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    projectsCache  = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    recurringCache = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 회의실 목록
    const snapshot = await getDocs(collection(db, "rooms"));
    const roomList  = document.getElementById("roomList");
    roomList.innerHTML = "";
    roomsCache = [];

    snapshot.forEach(d => {
        const room = d.data();
        roomsCache.push({ id: d.id, name: room.name });
        const li = document.createElement("li");
        li.innerText = room.name;
        li.addEventListener("click", () => {
            document.querySelectorAll("#roomList li").forEach(l => l.classList.remove("active"));
            li.classList.add("active");
            selectedRoomId   = d.id;
            selectedRoomName = room.name;
            renderSchedule();
        });
        roomList.appendChild(li);
    });

    if (roomsCache.length > 0) {
        selectedRoomId   = roomsCache[0].id;
        selectedRoomName = roomsCache[0].name;
        const firstLi = document.querySelector("#roomList li");
        if (firstLi) firstLi.classList.add("active");
        renderSchedule();
    }
});

document.getElementById("logoutBtn").addEventListener("click", () => location.reload());

// ── HELPERS ────────────────────────────────────────────────
function getDayIndexFromDateStr(dateStr) {
    const m = dateStr.match(/\((.)\)/);
    return m ? WEEK.indexOf(m[1]) : -1;
}

function buildDate(dateStr, timeStr) {
    const [monthDay] = dateStr.split("(");
    const [month, day] = monthDay.split("/");
    const startPart = timeStr.split("~")[0];
    const [hour, min] = startPart.split(":");
    const d = new Date();
    d.setMonth(parseInt(month) - 1);
    d.setDate(parseInt(day));
    d.setHours(parseInt(hour), parseInt(min), 0, 0);
    return d;
}
function timeStrToMins(t) { const [h,m]=t.split(":").map(Number); return h*60+m; }
function minsToTimeStr(mins) { return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0"); }



// ── RENDER SCHEDULE ────────────────────────────────────────
function renderSchedule() {
    document.getElementById("scheduleTitle").innerText = selectedRoomName;

    const days = [];
    const today = new Date();
    for (let i = 0; i < 14; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        days.push({ label: `${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`, day: d.getDay() });
    }

    function makeTimeLabel(h) {
        const [hh,mm] = h.split(":").map(Number);
        const em=hh*60+mm+30, eH=Math.floor(em/60), eM=em%60;
        return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}~${String(eH).padStart(2,"0")}:${String(eM).padStart(2,"0")}`;
    }

    // let html = '<table id="scheduleTable"><thead><tr><th class="time-col"></th>';
    let html = '<table id="scheduleTable"><thead><tr><th class="time-col time-lbl"></th>';
    days.forEach(d => {
        const wk = (d.day===0||d.day===6) ? "weekend" : "";
        html += `<th class="${wk}" data-date="${d.label}">${d.label}</th>`;
    });
    html += "</tr></thead><tbody>";
    HOURS.forEach(h => {
        html += `<tr><td class="time-lbl">${makeTimeLabel(h)}</td>`;
        days.forEach(d => {
            const wk = (d.day===0||d.day===6) ? "weekend" : "";
            html += `<td class="cell ${wk}" data-date="${d.label}" data-time="${h}"></td>`;
        });
        html += "</tr>";
    });
    html += "</tbody></table>";

    document.getElementById("scheduleArea").innerHTML = html;
    selectedCells = [];
    updateMultiButton();
    loadReservations();

    document.querySelectorAll(".cell").forEach(cell => {
        cell.addEventListener("click", () => {
            const { date, time } = cell.dataset;
            const existing = findReservationFromCache(date, time);  // 캐시, 동기

            if (existing) {
                openReservePopup(date, time, cell, existing);
                return;
            }
            if (cell.classList.contains("selected")) {
                cell.classList.remove("selected");
                selectedCells = selectedCells.filter(c => c !== cell);
            } else {
                cell.classList.add("selected");
                selectedCells.push(cell);
            }
            updateMultiButton();
        });
    });
}

// ── LOAD RESERVATIONS ──────────────────────────────────────
async function loadReservations() {
    // 같은 룸을 다시 열었을 때는 Firestore 재호출 없이 캐시 사용
    if (!reservationsByRoom[selectedRoomId]) {
        const rangeStart = new Date(); rangeStart.setHours(0,0,0,0);
        const rangeEnd   = new Date(); rangeEnd.setDate(rangeEnd.getDate()+14); rangeEnd.setHours(23,59,59,999);

        const resQuery = query(
            collection(db, "reservations"),
            where("roomId", "==", selectedRoomId)
        );
        const snap = await getDocs(resQuery);
        setRoomReservations(
            snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(d => {
                    const s = d.startTime.toDate();
                    return s >= rangeStart && s <= rangeEnd;
                })
        );
    }

    getRoomReservations().forEach(data => {
        const s = data.startTime.toDate();
        const e = data.endTime.toDate();
        const dateStr   = `${s.getMonth()+1}/${s.getDate()}(${WEEK[s.getDay()]})`;
        const startMins = s.getHours()*60 + s.getMinutes();
        const endMins   = e.getHours()*60 + e.getMinutes();
        const slots     = Math.round((endMins - startMins) / 30);
        const timeStr   = minsToTimeStr(startMins);
        const dn = data.creatorRole === "admin" ? "관리자" : data.createdByName;
        setCell(dateStr, timeStr, "reserved", data.title || dn, data.projectName, false, dn, slots);
    });

    // 정기 회의: recurringCache 사용 (추가 Firestore 조회 없음)
    document.querySelectorAll(".cell:not(.reserved):not(.merged)").forEach(cell => {
        const dayIdx    = getDayIndexFromDateStr(cell.dataset.date);
        const startMins = timeStrToMins(cell.dataset.time);
        const startHour = Math.floor(startMins/60);
        const startMin  = startMins%60;
        recurringCache.forEach(data => {
            if (data.roomId !== selectedRoomId) return;
            const rStartMin = data.startMin ?? 0;
            if (data.dayOfWeek === dayIdx && data.startHour === startHour && rStartMin === startMin) {
                const slots = data.durationSlots || 2;
                const dn = data.creatorRole === "admin" ? "관리자" : data.createdByName;
                setCell(cell.dataset.date, cell.dataset.time, "recurring", data.title, data.projectName, true, dn, slots);
            }
        });
    });
}

function setCell(dateStr, timeStr, cssClass, nameTxt, projectTxt, isRecurring, creatorName, slots=1) {
    const cell = document.querySelector(`.cell[data-date="${dateStr}"][data-time="${timeStr}"]`);
    if (!cell) return;
    if (slots > 1) {
        cell.rowSpan = slots;
        const startMins = timeStrToMins(timeStr);
        for (let i=1; i<slots; i++) {
            const next = document.querySelector(`.cell[data-date="${dateStr}"][data-time="${minsToTimeStr(startMins+i*30)}"]`);
            if (next) { next.style.display="none"; next.classList.add("merged"); }
        }
    }
    cell.classList.add(cssClass);
    cell.style.display = "";
    cell.style.verticalAlign = "top";
    cell.innerHTML = `
        <div class="cell-name${isRecurring?" is-recurring":""}">
            ${isRecurring?"🔄 ":""}${nameTxt||""}
        </div>
        <div class="cell-project">${projectTxt||""}</div>
        ${creatorName?`<div class="cell-creator">${creatorName}</div>`:""}
    `;
}

// ── FIND RESERVATION (캐시 기반, 동기) ────────────────────
function findReservationFromCache(date, time) {
    const clickedMins = timeStrToMins(time);

    for (const data of getRoomReservations()) {
        const s = data.startTime.toDate();
        const e = data.endTime.toDate();
        const dateStr   = `${s.getMonth()+1}/${s.getDate()}(${WEEK[s.getDay()]})`;
        const startMins = s.getHours()*60 + s.getMinutes();
        const endMins   = e.getHours()*60 + e.getMinutes();
        if (dateStr === date && clickedMins >= startMins && clickedMins < endMins)
            return { ...data };
    }

    const dayIdx = getDayIndexFromDateStr(date);
    for (const data of recurringCache) {
        if (data.roomId !== selectedRoomId) continue;
        const rStart = data.startHour*60 + (data.startMin ?? 0);
        const rEnd   = rStart + (data.durationSlots || 2)*30;
        // 클릭 슬롯이 정기회의 범위 안에 있는지 (dayOfWeek 일치 + 시간 범위)
        if (data.dayOfWeek === dayIdx && clickedMins >= rStart && clickedMins < rEnd)
            return { ...data, isRecurring: true };
    }
    return null;
}

// ── OPEN RESERVE POPUP ─────────────────────────────────────
async function openReservePopup(date, time, cell, existing=null) {
    const isRecurring = !!(existing && existing.isRecurring);
    const isOwner     = !existing || existing.createdBy === currentUserId;
    const isAdmin     = currentUserRole === "admin";

    const saveBtn   = document.getElementById("saveReserveBtn");
    const deleteBtn = document.getElementById("deleteReserveBtn");

    if (isRecurring) {
        saveBtn.style.display   = "none";
        deleteBtn.style.display = isAdmin ? "flex" : "none";
    } else {
        saveBtn.style.display   = isOwner ? "flex" : "none";
        deleteBtn.style.display = (isOwner && existing) ? "flex" : "none";
    }

    const editable = isOwner && !isRecurring;
    document.getElementById("reserveTitle").disabled  = !editable;
    document.getElementById("deptSelect").disabled    = !editable;
    document.getElementById("projectSelect").disabled = !editable;

    // 제목: 다중 선택 시 전체 날짜/시간 표시
    if (isRecurring) {
        document.getElementById("popupTitle").innerHTML =
            `🔄 정기 회의 · ${existing.title}`;
    } else if (window._multiCells && window._multiCells.length > 1) {
        const cells = window._multiCells;
        // 날짜별로 그룹핑해서 표시
        const byDate = {};
        cells.forEach(c => {
            if (!byDate[c.dataset.date]) byDate[c.dataset.date] = [];
            byDate[c.dataset.date].push(c.dataset.time);
        });
        const lines = Object.entries(byDate).map(([d, times]) => {
            times.sort((a,b) => timeStrToMins(a)-timeStrToMins(b));
            // 연속 구간 묶기
            const groups = [[times[0]]];
            for (let i=1; i<times.length; i++) {
                if (timeStrToMins(times[i])-timeStrToMins(times[i-1])===30) groups[groups.length-1].push(times[i]);
                else groups.push([times[i]]);
            }
            const timeRanges = groups.map(g => {
                const start = g[0];
                const endMins = timeStrToMins(g[g.length-1]) + 30;
                return `${start}~${minsToTimeStr(endMins)}`;
            }).join(", ");
            return `<span style="display:block;font-size:13px;font-weight:700;">${selectedRoomName} ${d}</span><span style="display:block;font-size:11px;color:var(--text-muted);margin-bottom:4px;">${timeRanges}</span>`;
        });
        document.getElementById("popupTitle").innerHTML = lines.join("");
    } else {
        document.getElementById("popupTitle").innerText =
            `${selectedRoomName}  ${date}  ${time}`;
    }

    // 부서 목록 (usersCache 사용)
    const deptSet = new Set(usersCache.map(u => u.dept));
    const deptSelect = document.getElementById("deptSelect");
    deptSelect.innerHTML = "";
    sortDepts(deptSet).forEach(dept => {
        const opt = document.createElement("option");
        opt.value = opt.text = dept;
        deptSelect.appendChild(opt);
    });

    document.getElementById("reserveTitle").value = existing?.title || "";
    if (existing && !isRecurring) {
        deptSelect.value = existing.dept;
        loadProjectsByDept(existing.dept);
        document.getElementById("projectSelect").value = existing.projectId;
        loadUsersByDept(existing.dept);
        document.querySelectorAll("#userList input").forEach(el => el.disabled = !editable);
        (existing.participants || []).forEach(id => {
            const chk = document.querySelector(`#userList input[value="${id}"]`);
            if (chk) chk.checked = true;
        });
        updateSelectedUsers();
    } else {
        loadProjectsByDept(deptSelect.value);
        loadUsersByDept(deptSelect.value);
    }

    deptSelect.onchange = () => {
        loadProjectsByDept(deptSelect.value);
        loadUsersByDept(deptSelect.value);
    };

    document.getElementById("closePopupBtn").onclick = () =>
        (document.getElementById("reservePopup").style.display = "none");

    deleteBtn.onclick = async () => {
        const label = isRecurring ? "정기 회의를" : "예약을";
        if (!confirm(`이 ${label} 삭제하시겠습니까?`)) return;
        await deleteDoc(doc(db, isRecurring ? "recurringMeetings" : "reservations", existing.id));
        if (isRecurring) recurringCache = recurringCache.filter(r => r.id !== existing.id);
        else             setRoomReservations(getRoomReservations().filter(r => r.id !== existing.id));
        document.getElementById("reservePopup").style.display = "none";
        renderSchedule();
    };

    saveBtn.onclick = async () => {
        const meetingTitle = document.getElementById("reserveTitle").value.trim();
        if (!meetingTitle) { alert("회의 제목을 입력하세요"); return; }

        const userName    = usersCache.find(u => u.id === currentUserId)?.name || "";
        const dept        = deptSelect.value;
        const pSel        = document.getElementById("projectSelect");
        const projectId   = pSel.value;
        const projectName = pSel.options[pSel.selectedIndex]?.text || "";
        const participants = [...document.querySelectorAll("#userList input:checked")].map(c => c.value);

        const targets = window._multiCells || [cell];

        // ── 중복 체크 (캐시 기반, Firestore 호출 없음) ──
        let duplicated = false;
        outer: for (const c of targets) {
            const slotMins = timeStrToMins(c.dataset.time);
            const slotEnd  = slotMins + 30;
            const dayIdx   = getDayIndexFromDateStr(c.dataset.date);

            for (const r of getRoomReservations()) {
                if (existing && r.id === existing.id) continue;
                const rS = r.startTime.toDate();
                const rDateStr = `${rS.getMonth()+1}/${rS.getDate()}(${WEEK[rS.getDay()]})`;
                if (rDateStr !== c.dataset.date) continue;
                const rSm = rS.getHours()*60 + rS.getMinutes();
                const rEm = r.endTime.toDate().getHours()*60 + r.endTime.toDate().getMinutes();
                if (slotMins < rEm && slotEnd > rSm) { duplicated=true; break outer; }
            }

            // 정기 회의: durationSlots 반영한 범위 체크
            for (const r of recurringCache) {
                if (r.roomId !== selectedRoomId || r.dayOfWeek !== dayIdx) continue;
                const rStart = r.startHour*60 + (r.startMin ?? 0);
                const rEnd   = rStart + (r.durationSlots || 2)*30;
                if (slotMins < rEnd && slotEnd > rStart) { duplicated=true; break outer; }
            }
        }

        if (duplicated) { alert("이미 예약된 시간입니다."); return; }

        const baseData = {
            roomId: selectedRoomId, title: meetingTitle, dept, projectId, projectName, participants,
            createdBy: currentUserId, createdByName: userName, creatorRole: currentUserRole, createdAt: new Date()
        };

        const byDate = {};
        targets.forEach(c => { if (!byDate[c.dataset.date]) byDate[c.dataset.date]=[]; byDate[c.dataset.date].push(c.dataset.time); });
        for (const [dateStr, times] of Object.entries(byDate)) {
            times.sort((a,b) => timeStrToMins(a)-timeStrToMins(b));
            const groups = [[times[0]]];
            for (let i=1; i<times.length; i++) {
                if (timeStrToMins(times[i])-timeStrToMins(times[i-1])===30) groups[groups.length-1].push(times[i]);
                else groups.push([times[i]]);
            }
            for (const group of groups) {
                const start = buildDate(dateStr, group[0]);
                const end   = buildDate(dateStr, group[group.length-1]);
                end.setMinutes(end.getMinutes()+30);
                const payload = { ...baseData, startTime: start, endTime: end };
                if (existing && !window._multiCells) {
                    await updateDoc(doc(db,"reservations",existing.id), payload);
                    setRoomReservations(getRoomReservations().map(r => r.id===existing.id ? {id:existing.id,...payload} : r));
                } else {
                    const ref = await addDoc(collection(db,"reservations"), payload);
                    setRoomReservations([...getRoomReservations(), { id: ref.id, ...payload }]);
                }
            }
        }

        selectedCells      = [];
        window._multiCells = null;
        document.getElementById("reservePopup").style.display = "none";
        renderSchedule();
    };

    document.getElementById("userSearch").onkeyup = filterUsers;
    document.getElementById("reservePopup").style.display = "block";
}

// ── RECURRING MANAGER ──────────────────────────────────────
async function openRecurringManager() {
    document.getElementById("recurringModal").style.display = "block";
    await loadRecurringList();

    document.getElementById("rRoom").innerHTML =
        roomsCache.map(r => `<option value="${r.id}">${r.name}</option>`).join("");

    const rTime    = document.getElementById("rTime");
    const rEndTime = document.getElementById("rEndTime");
    rTime.innerHTML    = HOURS.map(h => `<option value="${h}">${h}</option>`).join("");
    rEndTime.innerHTML = HOURS.map(h => `<option value="${h}">${h}</option>`).join("");

    function syncEndTimeOptions() {
        const startMins = timeStrToMins(rTime.value);
        const curEnd    = rEndTime.value;
        rEndTime.innerHTML = HOURS
            .filter(h => timeStrToMins(h) > startMins)
            .map(h => `<option value="${h}">${h}</option>`).join("");
        if (rEndTime.querySelector(`option[value="${curEnd}"]`)) rEndTime.value = curEnd;
    }
    rTime.onchange = syncEndTimeOptions;
    syncEndTimeOptions();

    const deptSet = new Set(usersCache.map(u => u.dept));
    const rDept = document.getElementById("rDept");
    rDept.innerHTML = "";
    sortDepts(deptSet).forEach(dept => {
        const opt = document.createElement("option");
        opt.value = opt.text = dept;
        rDept.appendChild(opt);
    });

    loadRProjectsByDept(rDept.value);
    loadRUsersByDept(rDept.value);
    rDept.onchange = () => { loadRProjectsByDept(rDept.value); loadRUsersByDept(rDept.value); };
}

async function loadRecurringList() {
    const list = document.getElementById("recurringList");
    list.innerHTML = "";
    if (!recurringCache.length) {
        list.innerHTML = `<div class="ri-empty">등록된 정기 회의가 없습니다</div>`;
        return;
    }
    recurringCache.forEach(data => {
        const room = roomsCache.find(r => r.id === data.roomId);
        const sH = String(data.startHour).padStart(2,"0");
        const sM = String(data.startMin??0).padStart(2,"0");
        const totalEnd = data.startHour*60+(data.startMin??0)+(data.durationSlots||2)*30;
        const eH = String(Math.floor(totalEnd/60)).padStart(2,"0");
        const eM = String(totalEnd%60).padStart(2,"0");
        const dayName = WEEK[data.dayOfWeek] || "-";

        const item = document.createElement("div");
        item.className = "recurring-item";
        item.dataset.id = data.id;
        item.innerHTML = `
            <div class="ri-info" style="cursor:pointer;">
                <div class="ri-title">🔄 ${data.title}</div>
                <div class="ri-meta">📍 ${room?.name||"알 수 없음"} &nbsp;·&nbsp; 매주 ${dayName}요일 ${sH}:${sM} ~ ${eH}:${eM}</div>
                <div class="ri-meta">🏢 ${data.dept} &nbsp;·&nbsp; ${data.projectName||"-"}</div>
            </div>
            <div class="ri-actions">
                <button class="btn-ri-edit" data-id="${data.id}">수정</button>
                <button class="btn-ri-delete" data-id="${data.id}" data-title="${data.title}">삭제</button>
            </div>
        `;
        item.querySelector(".btn-ri-edit").onclick = (e) => {
            e.stopPropagation();
            selectRecurringForEdit(data);
        };
        item.querySelector(".ri-info").onclick = () => selectRecurringForEdit(data);
        item.querySelector(".btn-ri-delete").onclick = async (e) => {
            e.stopPropagation();
            const { id, title } = e.currentTarget.dataset;
            if (!confirm(`"${title}" 정기 회의를 삭제하시겠습니까?`)) return;
            await deleteDoc(doc(db, "recurringMeetings", id));
            recurringCache = recurringCache.filter(r => r.id !== id);
            if (editingRecurringId === id) cancelRecurringEdit();
            await loadRecurringList();
            if (selectedRoomId) renderSchedule();
        };
        list.appendChild(item);
    });
}

async function saveRecurringMeeting() {
    const roomId      = document.getElementById("rRoom").value;
    const dayOfWeek   = parseInt(document.getElementById("rDay").value);
    const rTimeVal    = document.getElementById("rTime").value;
    const rEndTimeVal = document.getElementById("rEndTime").value;
    const startHour   = parseInt(rTimeVal.split(":")[0]);
    const startMin    = parseInt(rTimeVal.split(":")[1]);
    const title       = document.getElementById("rTitle").value.trim();
    const dept        = document.getElementById("rDept").value;
    const pSel        = document.getElementById("rProject");
    const projectId   = pSel.value;
    const projectName = pSel.options[pSel.selectedIndex]?.text || "";
    const participants = [...document.querySelectorAll("#rUserList input:checked")].map(c => c.value);

    if (!title) { alert("회의 제목을 입력하세요"); return; }
    if (!rEndTimeVal) { alert("종료 시간을 선택하세요"); return; }

    const newStart      = startHour*60 + startMin;
    const newEnd        = timeStrToMins(rEndTimeVal);
    const durationSlots = Math.round((newEnd - newStart) / 30);
    if (durationSlots <= 0) { alert("종료 시간은 시작 시간보다 늦어야 합니다."); return; }

    // 중복 체크 (자기 자신 제외)
    const dup = recurringCache.some(r => {
        if (r.id === editingRecurringId) return false;
        if (r.roomId !== roomId || r.dayOfWeek !== dayOfWeek) return false;
        const rS = r.startHour*60 + (r.startMin??0);
        const rE = rS + (r.durationSlots||2)*30;
        return newStart < rE && newEnd > rS;
    });
    if (dup) { alert("해당 요일/시간에 이미 정기 회의가 등록되어 있습니다."); return; }

    const userName = usersCache.find(u => u.id === currentUserId)?.name || "";
    const room     = roomsCache.find(r => r.id === roomId);
    const payload  = {
        roomId, roomName: room?.name||"", dayOfWeek, startHour, startMin, durationSlots, title,
        dept, projectId, projectName, participants,
        createdByName: userName, creatorRole: currentUserRole
    };

    if (editingRecurringId) {
        await updateDoc(doc(db, "recurringMeetings", editingRecurringId), payload);
        recurringCache = recurringCache.map(r =>
            r.id === editingRecurringId ? { ...r, ...payload } : r
        );
        alert(`✅ "${title}" 정기 회의가 수정되었습니다`);
    } else {
        const fullPayload = { ...payload, createdBy: currentUserId, createdAt: new Date() };
        const ref = await addDoc(collection(db, "recurringMeetings"), fullPayload);
        recurringCache.push({ id: ref.id, ...fullPayload });
        alert(`✅ "${title}" 정기 회의가 등록되었습니다`);
    }

    cancelRecurringEdit();
    await loadRecurringList();
    if (selectedRoomId) renderSchedule();
}

// ── PROJECT / USER LOADERS (캐시 기반, 동기) ───────────────
function getNumericId(id) { return Number(id.replace(/[^0-9]/g,"")); }

function loadRProjectsByDept(dept) {
    const sel = document.getElementById("rProject");
    sel.innerHTML = "";
    projectsCache
        .filter(p => dept==="에너지부문" || p.dept===dept)
        .sort((a,b) => getNumericId(b.id)-getNumericId(a.id))
        .forEach(p => { const o=document.createElement("option"); o.value=p.id; o.text=p.name; sel.appendChild(o); });
}

function loadRUsersByDept(dept) {
    const list = document.getElementById("rUserList");
    list.innerHTML = "";
    usersCache
        .filter(u => dept==="에너지부문" || u.dept===dept)
        .sort((a,b) => a.name.localeCompare(b.name,"ko"))
        .forEach(u => {
            const label=document.createElement("label"), chk=document.createElement("input");
            chk.type="checkbox"; chk.value=u.id;
            label.appendChild(chk); label.appendChild(document.createTextNode(u.name));
            list.appendChild(label);
        });
}

function loadProjectsByDept(dept) {
    const sel = document.getElementById("projectSelect");
    sel.innerHTML = "";
    projectsCache
        .filter(p => dept==="에너지부문" || p.dept===dept)
        .sort((a,b) => getNumericId(b.id)-getNumericId(a.id))
        .forEach(p => { const o=document.createElement("option"); o.value=p.id; o.text=p.name; sel.appendChild(o); });
}

function loadUsersByDept(dept) {
    const list = document.getElementById("userList");
    list.innerHTML = "";
    usersCache
        .filter(u => dept==="에너지부문" || u.dept===dept)
        .sort((a,b) => a.name.localeCompare(b.name,"ko"))
        .forEach(u => {
            const label=document.createElement("label"), chk=document.createElement("input");
            chk.type="checkbox"; chk.value=u.id;
            chk.addEventListener("change", updateSelectedUsers);
            label.appendChild(chk); label.appendChild(document.createTextNode(u.name));
            list.appendChild(label);
        });
    updateSelectedUsers();
}

function filterUsers() {
    const kw = document.getElementById("userSearch").value.toLowerCase();
    document.querySelectorAll("#userList label").forEach(lbl => {
        lbl.style.display = lbl.innerText.toLowerCase().includes(kw) ? "flex" : "none";
    });
}

function updateSelectedUsers() {
    const div = document.getElementById("selectedUsers");
    div.innerHTML = "";
    document.querySelectorAll("#userList input:checked").forEach(chk => {
        const span = document.createElement("span");
        span.innerText = chk.parentElement.innerText.trim();
        div.appendChild(span);
    });
}

function updateMultiButton() {
    document.getElementById("multiReserveBtn").disabled = selectedCells.length === 0;
}

// ── ADMIN UPLOADS ──────────────────────────────────────────
async function uploadUsers() {
    const file = document.getElementById("userFile").files[0];
    if (!file) return;
    if (!confirm("기존 사용자 데이터를 모두 삭제하고 새 파일로 교체합니다. 계속하시겠습니까?")) return;

    const wb   = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!rows.length) { alert("파일에 데이터가 없습니다."); return; }

    // 기존 문서 전체 삭제 후 새 데이터 일괄 쓰기 (batch 500개 제한 처리)
    const existingSnap = await getDocs(collection(db, "users"));
    const allDocs = [...existingSnap.docs];
    const newRows  = rows.map(row => ({
        id: String(row.id),
        data: { name: row.name, dept: row.dept, role: row.role || "user" }
    }));

    // 삭제 + 쓰기를 500개 단위 batch로 처리
    const ops = [
        ...allDocs.map(d => ({ type: "delete", ref: d.ref })),
        ...newRows.map(r => ({ type: "set",    ref: doc(db, "users", r.id), data: r.data }))
    ];
    for (let i = 0; i < ops.length; i += 500) {
        const batch = writeBatch(db);
        ops.slice(i, i + 500).forEach(op => {
            if (op.type === "delete") batch.delete(op.ref);
            else                      batch.set(op.ref, op.data);
        });
        await batch.commit();
    }

    // 캐시 갱신
    usersCache = newRows.map(r => ({ id: r.id, ...r.data }));
    alert(`✅ 사용자 ${newRows.length}명으로 교체 완료`);
}

async function uploadProjects() {
    const file = document.getElementById("projectFile").files[0];
    if (!file) return;
    if (!confirm("기존 프로젝트 데이터를 모두 삭제하고 새 파일로 교체합니다. 계속하시겠습니까?")) return;

    const wb   = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!rows.length) { alert("파일에 데이터가 없습니다."); return; }

    const existingSnap = await getDocs(collection(db, "projects"));
    const allDocs = [...existingSnap.docs];
    const newRows  = rows.map(row => ({
        id: String(row.id),
        data: { name: row.name, dept: row.dept }
    }));

    const ops = [
        ...allDocs.map(d => ({ type: "delete", ref: d.ref })),
        ...newRows.map(r => ({ type: "set",    ref: doc(db, "projects", r.id), data: r.data }))
    ];
    for (let i = 0; i < ops.length; i += 500) {
        const batch = writeBatch(db);
        ops.slice(i, i + 500).forEach(op => {
            if (op.type === "delete") batch.delete(op.ref);
            else                      batch.set(op.ref, op.data);
        });
        await batch.commit();
    }

    projectsCache = newRows.map(r => ({ id: r.id, ...r.data }));
    alert(`✅ 프로젝트 ${newRows.length}건으로 교체 완료`);
}

// ── MULTI RESERVE ──────────────────────────────────────────
document.getElementById("multiReserveBtn").disabled = true;
document.getElementById("multiReserveBtn").onclick = () => {
    if (selectedCells.length === 0) return;
    window._multiCells = [...selectedCells];
    const first = selectedCells[0];
    openReservePopup(first.dataset.date, first.dataset.time, first, null);
};

// ── RECURRING EDIT HELPERS ────────────────────────────────
function selectRecurringForEdit(data) {
    editingRecurringId = data.id;

    document.querySelectorAll(".recurring-item").forEach(el => {
        el.classList.toggle("active", el.dataset.id === data.id);
    });

    document.getElementById("rTitle").value = data.title || "";

    const rRoom = document.getElementById("rRoom");
    if (rRoom.querySelector(`option[value="${data.roomId}"]`)) rRoom.value = data.roomId;
    document.getElementById("rDay").value = String(data.dayOfWeek);

    const startStr = minsToTimeStr(data.startHour*60 + (data.startMin??0));
    const endMins  = data.startHour*60 + (data.startMin??0) + (data.durationSlots||2)*30;
    const endStr   = minsToTimeStr(endMins);

    const rTime = document.getElementById("rTime");
    if (rTime.querySelector(`option[value="${startStr}"]`)) rTime.value = startStr;

    const rEndTime = document.getElementById("rEndTime");
    rEndTime.innerHTML = HOURS
        .filter(h => timeStrToMins(h) > timeStrToMins(startStr))
        .map(h => `<option value="${h}">${h}</option>`).join("");
    if (rEndTime.querySelector(`option[value="${endStr}"]`)) rEndTime.value = endStr;

    const rDept = document.getElementById("rDept");
    if (rDept.querySelector(`option[value="${data.dept}"]`)) rDept.value = data.dept;
    loadRProjectsByDept(data.dept);
    const rProject = document.getElementById("rProject");
    if (rProject.querySelector(`option[value="${data.projectId}"]`)) rProject.value = data.projectId;
    loadRUsersByDept(data.dept);
    setTimeout(() => {
        (data.participants || []).forEach(id => {
            const chk = document.querySelector(`#rUserList input[value="${id}"]`);
            if (chk) chk.checked = true;
        });
    }, 0);

    document.getElementById("rFormMode").className   = "rm-form-mode mode-edit";
    document.getElementById("rFormMode").textContent = "✏️ 수정 중";
    document.getElementById("saveRecurringBtn").textContent = "✅ 변경 저장";
    document.getElementById("cancelEditBtn").style.display  = "block";
    document.querySelector(".rm-form-panel").scrollTop = 0;
}

function cancelRecurringEdit() {
    editingRecurringId = null;
    document.querySelectorAll(".recurring-item").forEach(el => el.classList.remove("active"));
    document.getElementById("rTitle").value = "";
    document.querySelectorAll("#rUserList input:checked").forEach(c => c.checked = false);
    document.getElementById("rFormMode").className   = "rm-form-mode mode-new";
    document.getElementById("rFormMode").textContent = "+ 새 회의 등록";
    document.getElementById("saveRecurringBtn").textContent = "🔄 정기 회의 등록";
    document.getElementById("cancelEditBtn").style.display  = "none";
}

// ── EXPOSE TO HTML ─────────────────────────────────────────
window.uploadUsers          = uploadUsers;
window.uploadProjects       = uploadProjects;
window.openRecurringManager = openRecurringManager;
window.saveRecurringMeeting = saveRecurringMeeting;
window.resetUserPassword    = resetUserPassword;
window.cancelRecurringEdit  = cancelRecurringEdit;
window.filterPwResetList    = filterPwResetList;
window.openPwResetPanel     = openPwResetPanel;

// ── PW RESET (관리자) ───────────────────────────────────────
function openPwResetPanel() {
    const panel  = document.getElementById("pwResetPanel");
    const isOpen = panel.style.display === "block";
    panel.style.display = isOpen ? "none" : "block";
    if (!isOpen) {
        document.getElementById("pwResetSearch").value = "";
        renderPwResetList(usersCache);
    }
}

function filterPwResetList() {
    const kw = document.getElementById("pwResetSearch").value.trim().toLowerCase();
    const filtered = kw
        ? usersCache.filter(u =>
            u.name.toLowerCase().includes(kw) ||
            u.id.toLowerCase().includes(kw) ||
            (u.dept || "").toLowerCase().includes(kw))
        : usersCache;
    renderPwResetList(filtered);
}

function renderPwResetList(users) {
    const list = document.getElementById("pwResetUserList");
    list.innerHTML = "";

    // 부서 → 이름 순 정렬
    const sorted = [...users].sort((a, b) => {
        const deptCmp = (a.dept||"").localeCompare(b.dept||"", "ko");
        return deptCmp !== 0 ? deptCmp : a.name.localeCompare(b.name, "ko");
    });

    if (!sorted.length) {
        list.innerHTML = `<div class="pw-reset-empty">검색 결과가 없습니다</div>`;
        return;
    }

    sorted.forEach(u => {
        const item = document.createElement("div");
        item.className = "pw-reset-item";
        item.innerHTML = `
            <div class="pw-reset-info">
                <div class="pw-reset-name">${u.name}</div>
                <div class="pw-reset-meta">${u.dept || "-"} &nbsp;·&nbsp; ${u.id}</div>
            </div>
            <button class="btn-pw-reset" data-id="${u.id}" data-name="${u.name}">리셋</button>
        `;
        item.querySelector(".btn-pw-reset").onclick = async (e) => {
            const btn = e.currentTarget;           // await 전에 미리 저장
            const { id, name } = btn.dataset;
            if (!confirm(`"${name}" (${id})의 비밀번호를 사용자 ID로 리셋하시겠습니까?`)) return;
            try {
                await updateDoc(doc(db, "users", id), { password: null });
                const cached = usersCache.find(u => u.id === id);
                if (cached) cached.password = null;
                // 시각적 피드백
                btn.textContent = "✅ 완료";
                btn.style.background = "rgba(52,217,179,0.15)";
                btn.style.color = "var(--accent)";
                btn.style.borderColor = "rgba(52,217,179,0.3)";
                btn.disabled = true;
                setTimeout(() => {
                    btn.textContent = "리셋";
                    btn.style.background = "";
                    btn.style.color = "";
                    btn.style.borderColor = "";
                    btn.disabled = false;
                }, 2000);
            } catch(e) { alert("리셋 실패: " + e.message); }
        };
        list.appendChild(item);
    });
}

async function resetUserPassword() {}  // 레거시 (더 이상 사용 안 함)

// ── PASSWORD POPUP ──────────────────────────────────────────
function openPwPopup() {
    document.getElementById("newPw").value     = "";
    document.getElementById("confirmPw").value = "";
    document.getElementById("pwOverlay").style.display = "block";
    document.getElementById("pwPopup").style.display   = "block";
}
function closePwPopup() {
    document.getElementById("pwOverlay").style.display = "none";
    document.getElementById("pwPopup").style.display   = "none";
}
document.getElementById("pwSkipBtn").addEventListener("click", closePwPopup);
document.getElementById("pwSaveBtn").addEventListener("click", async () => {
    const newPw     = document.getElementById("newPw").value.trim();
    const confirmPw = document.getElementById("confirmPw").value.trim();
    if (!/^\d{6}$/.test(newPw))    { alert("숫자 6자리를 입력하세요"); return; }
    if (newPw !== confirmPw)        { alert("비밀번호가 일치하지 않습니다"); return; }
    if (newPw === currentUserId)    { alert("사용자 ID는 초기 비밀번호입니다. 다른 번호를 사용하세요"); return; }
    try {
        await updateDoc(doc(db, "users", currentUserId), { password: newPw });
        const u = usersCache.find(u => u.id===currentUserId);
        if (u) u.password = newPw;
        closePwPopup();
        alert("✅ 비밀번호가 변경되었습니다");
    } catch(e) { alert("저장 실패: "+e.message); }
});
