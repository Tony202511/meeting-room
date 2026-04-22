import { db } from "./firebase.js";
import {
    collection,
    getDocs,
    doc,
    getDoc,
    setDoc,
    addDoc,
    deleteDoc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── STATE ──────────────────────────────────────────────────
let selectedRoomId   = null;
let selectedRoomName = null;
let currentUserId    = null;
let currentUserRole  = null;
let selectedCells    = [];
let roomsCache       = [];   // { id, name }[]

const WEEK  = ["일","월","화","수","목","금","토"];
const HOURS = ["09:00~10:00","10:00~11:00","11:00~12:00","12:00~13:00","13:00~14:00","14:00~15:00","15:00~16:00","16:00~17:00","17:00~18:00"];

// ── LOGIN ──────────────────────────────────────────────────
document.getElementById("loginBtn").addEventListener("click", async () => {
    const empNo = document.getElementById("empNo").value.trim();
    const pw    = document.getElementById("loginPw").value.trim();

    if (!empNo) { alert("사번을 입력하세요"); return; }
    if (!pw)    { alert("비밀번호를 입력하세요"); return; }

    const docSnap = await getDoc(doc(db, "users", empNo));
    if (!docSnap.exists()) { alert("존재하지 않는 사번입니다."); return; }

    const user = docSnap.data();

    // 비밀번호 확인 (미설정 시 초기값 = 0000)
    const storedPw = user.password ?? "0000";
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

    // 초기 비밀번호(사번) 사용 중이면 변경 팝업 표시
    if (!user.password) {
        openPwPopup();
    }

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

    // 첫 번째 회의실 자동 선택
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
    const [hour, min]  = timeStr.split(":");
    const d = new Date();
    d.setMonth(parseInt(month) - 1);
    d.setDate(parseInt(day));
    d.setHours(parseInt(hour), parseInt(min), 0, 0);
    return d;
}

// ── RENDER SCHEDULE ────────────────────────────────────────
function renderSchedule() {
    document.getElementById("scheduleTitle").innerText = selectedRoomName;

    const days = [];
    const today = new Date();
    for (let i = 0; i < 14; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);

        days.push({
            label: `${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`,
            day: d.getDay()
        });
    }

    let html = "<table><tr><th></th>";
    days.forEach(d => {
    const weekend = (d.day === 0 || d.day === 6) ? "weekend" : "";
    html += `<th class="${weekend}">${d.label}</th>`;
});
    html += "</tr>";
    HOURS.forEach(h => {
        html += `<tr><td>${h}</td>`;
        days.forEach(d => {
            const weekend = (d.day === 0 || d.day === 6) ? "weekend" : "";
            html += `<td class="cell ${weekend}" 
                        data-date="${d.label}" 
                        data-time="${h}"></td>`;
        });
                html += "</tr>";
    });
    html += "</table>";

    document.getElementById("scheduleArea").innerHTML = html;
    selectedCells = [];
    updateMultiButton();
    loadReservations();

    document.querySelectorAll(".cell").forEach(cell => {
        cell.addEventListener("click", async () => {
            const { date, time } = cell.dataset;
            const existing = await findReservation(date, time);

            if (existing) {
                openReservePopup(date, time, cell, existing);
                return;
            }

            // 빈 셀 토글 선택
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
    // 일반 예약
    const snap = await getDocs(collection(db, "reservations"));
    snap.forEach(d => {
        const data = d.data();
        if (data.roomId !== selectedRoomId) return;
        const s = data.startTime.toDate();
        const dateStr = `${s.getMonth()+1}/${s.getDate()}(${WEEK[s.getDay()]})`;
        const h = s.getHours();
        const timeStr = `${String(h).padStart(2,"0")}:00~${String(h+1).padStart(2,"0")}:00`;
        setCell(dateStr, timeStr, "reserved", data.title || data.createdByName, data.projectName, false, data.createdByName);
    });

    // 정기 회의
    const rSnap = await getDocs(collection(db, "recurringMeetings"));
    document.querySelectorAll(".cell:not(.reserved)").forEach(cell => {
        const dayIdx = getDayIndexFromDateStr(cell.dataset.date);
        const hour   = parseInt(cell.dataset.time);
        rSnap.forEach(d => {
            const data = d.data();
            if (data.roomId !== selectedRoomId) return;
            if (data.dayOfWeek === dayIdx && data.startHour === hour) {
                setCell(cell.dataset.date, cell.dataset.time, "recurring", data.title, data.projectName, true, data.createdByName);
            }
        });
    });
}

function setCell(dateStr, timeStr, cssClass, nameTxt, projectTxt, isRecurring, creatorName) {
    const cell = document.querySelector(`.cell[data-date="${dateStr}"][data-time="${timeStr}"]`);
    if (!cell) return;
    cell.classList.add(cssClass);
    cell.innerHTML = `
        <div class="cell-name${isRecurring ? " is-recurring" : ""}">
            ${isRecurring ? "🔄 " : ""}${nameTxt || ""}
        </div>
        <div class="cell-project">${(projectTxt || "").substring(0, 8)}</div>
        ${creatorName ? `<div class="cell-creator">${creatorName}</div>` : ""}
    `;
}

// ── FIND RESERVATION ───────────────────────────────────────
async function findReservation(date, time) {
    // 일반 예약 검색
    const snap = await getDocs(collection(db, "reservations"));
    for (const d of snap.docs) {
        const data = d.data();
        if (data.roomId !== selectedRoomId) continue;
        const s = data.startTime.toDate();
        const dateStr = `${s.getMonth()+1}/${s.getDate()}(${WEEK[s.getDay()]})`;
        const h = s.getHours();
        const timeStr = `${String(h).padStart(2,"0")}:00~${String(h+1).padStart(2,"0")}:00`;
        if (dateStr === date && timeStr === time) return { id: d.id, ...data };
    }

    // 정기 회의 검색
    const dayIdx = getDayIndexFromDateStr(date);
    const hour   = parseInt(time.split(":")[0]);
    const rSnap  = await getDocs(collection(db, "recurringMeetings"));
    for (const d of rSnap.docs) {
        const data = d.data();
        if (data.roomId !== selectedRoomId) continue;
        if (data.dayOfWeek === dayIdx && data.startHour === hour) {
            return { id: d.id, ...data, isRecurring: true };
        }
    }

    return null;
}

// ── OPEN RESERVE POPUP ─────────────────────────────────────
async function openReservePopup(date, time, cell, existing = null) {
    const isRecurring = !!(existing && existing.isRecurring);
    const isOwner     = !existing || existing.createdBy === currentUserId;
    const isAdmin     = currentUserRole === "admin";

    // 버튼 표시 제어
    const saveBtn   = document.getElementById("saveReserveBtn");
    const deleteBtn = document.getElementById("deleteReserveBtn");

    if (isRecurring) {
        // 정기 회의: 저장 불가, 관리자만 삭제
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

    // 제목
    document.getElementById("popupTitle").innerText = isRecurring
        ? `🔄 정기 회의 · ${existing.title}`
        : `${selectedRoomName}  ${date}  ${time}`;

    // 부서 목록
    const deptSet  = new Set();
    const userSnap = await getDocs(collection(db, "users"));
    userSnap.forEach(d => deptSet.add(d.data().dept));

    const deptSelect = document.getElementById("deptSelect");
    deptSelect.innerHTML = "";
    deptSet.forEach(dept => {
        const opt = document.createElement("option");
        opt.value = opt.text = dept;
        deptSelect.appendChild(opt);
    });

    // 기존 값 채우기
    document.getElementById("reserveTitle").value = existing?.title || "";
    if (existing) {
        deptSelect.value = existing.dept;
        await loadProjectsByDept(existing.dept);
        document.getElementById("projectSelect").value = existing.projectId;
        await loadUsersByDept(existing.dept);
        document.querySelectorAll("#userList input").forEach(el => el.disabled = !editable);
        (existing.participants || []).forEach(id => {
            const chk = document.querySelector(`#userList input[value="${id}"]`);
            if (chk) chk.checked = true;
        });
        updateSelectedUsers();
    } else {
        await loadProjectsByDept(deptSelect.value);
        await loadUsersByDept(deptSelect.value);
    }

    deptSelect.onchange = () => {
        loadProjectsByDept(deptSelect.value);
        loadUsersByDept(deptSelect.value);
    };

    document.getElementById("closePopupBtn").onclick = () =>
        (document.getElementById("reservePopup").style.display = "none");

    // 삭제
    deleteBtn.onclick = async () => {
        const label = isRecurring ? "정기 회의를" : "예약을";
        if (!confirm(`이 ${label} 삭제하시겠습니까?`)) return;
        await deleteDoc(doc(db, isRecurring ? "recurringMeetings" : "reservations", existing.id));
        document.getElementById("reservePopup").style.display = "none";
        renderSchedule();
    };

    // 저장
    saveBtn.onclick = async () => {
        const meetingTitle = document.getElementById("reserveTitle").value.trim();
        if (!meetingTitle) { alert("회의 제목을 입력하세요"); return; }
        const userDoc   = await getDoc(doc(db, "users", currentUserId));
        const userName  = userDoc.data().name;
        const dept      = deptSelect.value;
        const pSel      = document.getElementById("projectSelect");
        const projectId = pSel.value;
        const projectName = pSel.options[pSel.selectedIndex]?.text || "";
        const participants = [...document.querySelectorAll("#userList input:checked")].map(c => c.value);

        const targets = window._multiCells || [cell];

        // 중복 체크 (일반 예약 + 정기 회의 모두)
        const allRes = await getDocs(collection(db, "reservations"));
        const allRec = await getDocs(collection(db, "recurringMeetings"));
        let duplicated = false;

        for (const c of targets) {
            const start = buildDate(c.dataset.date, c.dataset.time);
            const dayIdx = getDayIndexFromDateStr(c.dataset.date);
            const hour   = parseInt(c.dataset.time);

            allRes.forEach(r => {
                const rd = r.data();
                if (rd.roomId !== selectedRoomId) return;
                if (rd.startTime.toDate().getTime() === start.getTime()
                    && (!existing || r.id !== existing.id)) duplicated = true;
            });
            allRec.forEach(r => {
                const rd = r.data();
                if (rd.roomId !== selectedRoomId) return;
                if (rd.dayOfWeek === dayIdx && rd.startHour === hour) duplicated = true;
            });
        }

        if (duplicated) { alert("이미 예약된 시간입니다."); return; }

        const baseData = {
            roomId: selectedRoomId, title: meetingTitle, dept, projectId, projectName, participants,
            createdBy: currentUserId, createdByName: userName, createdAt: new Date()
        };

        for (const c of targets) {
            const start = buildDate(c.dataset.date, c.dataset.time);
            const end   = new Date(start);
            end.setHours(start.getHours() + 1);

            if (existing && !window._multiCells) {
                // 수정
                await updateDoc(doc(db, "reservations", existing.id), { ...baseData, startTime: start, endTime: end });
            } else {
                // 신규
                await addDoc(collection(db, "reservations"), { ...baseData, startTime: start, endTime: end });
            }
        }

        selectedCells    = [];
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

    // 회의실 목록
    const rRoom = document.getElementById("rRoom");
    rRoom.innerHTML = roomsCache.map(r => `<option value="${r.id}">${r.name}</option>`).join("");

    // 시간 목록
    const rTime = document.getElementById("rTime");
    rTime.innerHTML = HOURS.map(h => `<option value="${h.split(":")[0]}">${h}</option>`).join("");

    // 부서
    const deptSet  = new Set();
    const userSnap = await getDocs(collection(db, "users"));
    userSnap.forEach(d => deptSet.add(d.data().dept));

    const rDept = document.getElementById("rDept");
    rDept.innerHTML = [...deptSet].map(d => `<option value="${d}">${d}</option>`).join("");

    await loadRProjectsByDept(rDept.value);
    await loadRUsersByDept(rDept.value);

    rDept.onchange = () => {
        loadRProjectsByDept(rDept.value);
        loadRUsersByDept(rDept.value);
    };
}

async function loadRecurringList() {
    const snap = await getDocs(collection(db, "recurringMeetings"));
    const list  = document.getElementById("recurringList");
    list.innerHTML = "";

    if (snap.empty) {
        list.innerHTML = `<div class="ri-empty">등록된 정기 회의가 없습니다</div>`;
        return;
    }

    snap.forEach(d => {
        const data    = d.data();
        const room    = roomsCache.find(r => r.id === data.roomId);
        const timeStr = `${String(data.startHour).padStart(2,"0")}:00 ~ ${String(data.startHour+1).padStart(2,"0")}:00`;
        const dayName = WEEK[data.dayOfWeek] || "-";

        const item = document.createElement("div");
        item.className = "recurring-item";
        item.innerHTML = `
            <div class="ri-info">
                <div class="ri-title">🔄 ${data.title}</div>
                <div class="ri-meta">📍 ${room?.name || "알 수 없음"} &nbsp;·&nbsp; 매주 ${dayName}요일 ${timeStr}</div>
                <div class="ri-meta">🏢 ${data.dept} &nbsp;·&nbsp; ${data.projectName || "-"}</div>
            </div>
            <button class="btn-ri-delete" data-id="${d.id}" data-title="${data.title}">삭제</button>
        `;
        item.querySelector(".btn-ri-delete").onclick = async (e) => {
            const { id, title } = e.currentTarget.dataset;
            if (!confirm(`"${title}" 정기 회의를 삭제하시겠습니까?`)) return;
            await deleteDoc(doc(db, "recurringMeetings", id));
            await loadRecurringList();
            if (selectedRoomId) renderSchedule();
        };
        list.appendChild(item);
    });
}

async function saveRecurringMeeting() {
    const roomId  = document.getElementById("rRoom").value;
    const dayOfWeek = parseInt(document.getElementById("rDay").value);
    const startHour = parseInt(document.getElementById("rTime").value);
    const title   = document.getElementById("rTitle").value.trim();
    const dept    = document.getElementById("rDept").value;
    const pSel    = document.getElementById("rProject");
    const projectId   = pSel.value;
    const projectName = pSel.options[pSel.selectedIndex]?.text || "";
    const participants = [...document.querySelectorAll("#rUserList input:checked")].map(c => c.value);

    if (!title) { alert("회의 제목을 입력하세요"); return; }

    // 중복 정기 회의 체크
    const existing = await getDocs(collection(db, "recurringMeetings"));
    let duplicated = false;
    existing.forEach(d => {
        const data = d.data();
        if (data.roomId === roomId && data.dayOfWeek === dayOfWeek && data.startHour === startHour) {
            duplicated = true;
        }
    });
    if (duplicated) { alert("해당 요일/시간에 이미 정기 회의가 등록되어 있습니다."); return; }

    const userDoc  = await getDoc(doc(db, "users", currentUserId));
    const userName = userDoc.data().name;
    const room     = roomsCache.find(r => r.id === roomId);

    await addDoc(collection(db, "recurringMeetings"), {
        roomId, roomName: room?.name || "",
        dayOfWeek, startHour, title,
        dept, projectId, projectName, participants,
        createdBy: currentUserId, createdByName: userName,
        createdAt: new Date()
    });

    // 폼 초기화
    document.getElementById("rTitle").value = "";
    document.querySelectorAll("#rUserList input:checked").forEach(c => c.checked = false);

    await loadRecurringList();
    if (selectedRoomId) renderSchedule();
    alert(`✅ "${title}" 정기 회의가 등록되었습니다`);
}

async function loadRProjectsByDept(dept) {
    const sel  = document.getElementById("rProject");
    sel.innerHTML = "";
    const snap = await getDocs(collection(db, "projects"));
    snap.forEach(d => {
        const data = d.data();
        if (data.dept !== dept) return;
        const opt = document.createElement("option");
        opt.value = d.id; opt.text = data.name;
        sel.appendChild(opt);
    });
}

async function loadRUsersByDept(dept) {
    const list = document.getElementById("rUserList");
    list.innerHTML = "";
    const snap = await getDocs(collection(db, "users"));
    snap.forEach(d => {
        const user = d.data();
        if (user.dept !== dept) return;
        const label = document.createElement("label");
        const chk   = document.createElement("input");
        chk.type = "checkbox"; chk.value = d.id;
        label.appendChild(chk);
        label.appendChild(document.createTextNode(user.name));
        list.appendChild(label);
    });
}

// ── DEPT / PROJECT / USER LOADERS (reserve popup) ─────────
async function loadProjectsByDept(dept) {
    const sel  = document.getElementById("projectSelect");
    sel.innerHTML = "";
    const snap = await getDocs(collection(db, "projects"));
    snap.forEach(d => {
        const data = d.data();
        if (data.dept !== dept) return;
        const opt = document.createElement("option");
        opt.value = d.id; opt.text = data.name;
        sel.appendChild(opt);
    });
}

async function loadUsersByDept(dept) {
    const list = document.getElementById("userList");
    list.innerHTML = "";
    const snap = await getDocs(collection(db, "users"));
    snap.forEach(d => {
        const user = d.data();
        if (user.dept !== dept) return;
        const label = document.createElement("label");
        const chk   = document.createElement("input");
        chk.type = "checkbox"; chk.value = d.id;
        chk.addEventListener("change", updateSelectedUsers);
        label.appendChild(chk);
        label.appendChild(document.createTextNode(user.name));
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
    const rows = XLSX.utils.sheet_to_json(
        XLSX.read(await file.arrayBuffer()).Sheets[XLSX.read(await file.arrayBuffer()).SheetNames[0]]
    );
    for (const row of rows) {
        await setDoc(doc(db, "users", String(row.id)), { name: row.name, dept: row.dept, role: row.role || "user" });
    }
    alert("users 업로드 완료");
}

async function uploadProjects() {
    const file = document.getElementById("projectFile").files[0];
    if (!file) return;
    const rows = XLSX.utils.sheet_to_json(
        XLSX.read(await file.arrayBuffer()).Sheets[XLSX.read(await file.arrayBuffer()).SheetNames[0]]
    );
    for (const row of rows) {
        await setDoc(doc(db, "projects", String(row.id)), { name: row.name, dept: row.dept });
    }
    alert("projects 업로드 완료");
}

// ── MULTI RESERVE ──────────────────────────────────────────
document.getElementById("multiReserveBtn").disabled = true;
document.getElementById("multiReserveBtn").onclick = () => {
    if (selectedCells.length === 0) return;
    window._multiCells = [...selectedCells];
    const first = selectedCells[0];
    openReservePopup(first.dataset.date, first.dataset.time, first, null);
};

// ── EXPOSE TO HTML ─────────────────────────────────────────
window.uploadUsers          = uploadUsers;
window.uploadProjects       = uploadProjects;
window.openRecurringManager = openRecurringManager;
window.saveRecurringMeeting = saveRecurringMeeting;
window.resetUserPassword    = resetUserPassword;
window.openPwResetPanel     = openPwResetPanel;

// ── PW RESET (관리자) ───────────────────────────────────────
async function openPwResetPanel() {
    const panel = document.getElementById("pwResetPanel");
    const isOpen = panel.style.display === "block";
    panel.style.display = isOpen ? "none" : "block";

    if (!isOpen) {
        // 사용자 목록 채우기
        const sel = document.getElementById("pwResetUserSelect");
        sel.innerHTML = "<option value=''>사용자 선택...</option>";
        const snap = await getDocs(collection(db, "users"));
        snap.forEach(d => {
            const u = d.data();
            const opt = document.createElement("option");
            opt.value = d.id;
            opt.text  = `${u.name} (${d.id}) - ${u.dept}`;
            sel.appendChild(opt);
        });
    }
}

async function resetUserPassword() {
    const sel    = document.getElementById("pwResetUserSelect");
    const userId = sel.value;
    const userName = sel.options[sel.selectedIndex]?.text;

    if (!userId) { alert("사용자를 선택하세요"); return; }
    if (!confirm(`${userName}의 비밀번호를 0000으로 리셋하시겠습니까?`)) return;

    try {
        await updateDoc(doc(db, "users", userId), { password: null });
        alert(`✅ ${userName.split(" ")[0]}의 비밀번호가 0000으로 리셋되었습니다`);
        sel.value = "";
    } catch(e) {
        alert("리셋 실패: " + e.message);
    }
}

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

    if (!/^\d{4}$/.test(newPw)) {
        alert("숫자 4자리를 입력하세요");
        return;
    }
    if (newPw !== confirmPw) {
        alert("비밀번호가 일치하지 않습니다");
        return;
    }
    if (newPw === "0000") {
        alert("0000은 초기 비밀번호입니다. 다른 번호를 사용하세요");
        return;
    }

    await updateDoc(doc(db, "users", currentUserId), { password: newPw });
    closePwPopup();
    alert("✅ 비밀번호가 변경되었습니다");
});
