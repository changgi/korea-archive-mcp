/* 캐러셀 갤러리 뷰어 — series.html·series100.html 공용.
   기사(article) 안의 카드 이미지 링크(.strip/.set)를 한 세트로 묶어 인스타그램처럼 넘겨 본다.
   ← → 키·스와이프·썸네일 클릭, 소개글(caption.txt) 펼치기, 원본·ZIP 링크. */
(function () {
  const css = `
.gx-open{display:inline-flex;align-items:center;gap:6px;margin:4px 0 2px;background:#111;color:#fff;border:0;border-radius:999px;padding:9px 16px;font-weight:800;font-size:.9rem;cursor:pointer}
.gx-open:hover{background:#8a2a1f}
.gx-cov{cursor:zoom-in}
.gx{position:fixed;inset:0;z-index:9999;background:rgba(8,8,10,.96);display:none;flex-direction:column;color:#eee;font-family:inherit}
.gx.on{display:flex}
.gx-top{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:52px}
.gx-ttl{flex:1;font-weight:700;font-size:.98rem;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gx-cnt{font-variant-numeric:tabular-nums;color:#bbb;font-size:.9rem}
.gx-x{background:none;border:0;color:#fff;font-size:30px;line-height:1;cursor:pointer;padding:0 6px}
.gx-main{flex:1;display:flex;min-height:0;gap:18px;padding:0 12px}
.gx-stage{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;min-width:0;touch-action:pan-y}
.gx-stage img{max-width:100%;max-height:100%;aspect-ratio:1/1;object-fit:contain;border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.6);user-select:none;-webkit-user-drag:none;transition:opacity .15s}
.gx-nav{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;border-radius:50%;border:0;background:rgba(255,255,255,.9);color:#111;font-size:26px;font-weight:900;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)}
.gx-nav:disabled{opacity:.15;cursor:default}
.gx-prev{left:8px}.gx-next{right:8px}
.gx-dots{display:flex;justify-content:center;gap:6px;padding:8px 0 2px}
.gx-dots i{width:7px;height:7px;border-radius:50%;background:#555}.gx-dots i.on{background:#fff}
.gx-side{width:360px;max-width:36vw;overflow:auto;background:#17171b;border-radius:10px;padding:16px 18px;font-size:.9rem;line-height:1.65;display:none}
.gx-side.on{display:block}
.gx-side h4{font-size:1.02rem;color:#fff;margin:0 0 6px;line-height:1.45}.gx-side .gx-in{color:#e0b04a;font-weight:800;font-size:.82rem;margin-bottom:4px}
.gx-side .gx-q{background:#24314a;color:#cfe0ff;border-radius:10px 10px 10px 3px;padding:7px 11px;margin:8px 0;font-weight:700}
.gx-side dl,.gx-side dt,.gx-side dd,.gx-side ol,.gx-side li{background:none!important;border:0!important;box-shadow:none!important;border-radius:0!important}
.gx-side dl{padding:0!important;margin:8px 0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px}.gx-side dt{color:#e0907f!important;font-weight:800;padding:0!important}.gx-side dd{margin:0;padding:0!important;color:#ddd!important;overflow-wrap:anywhere}
.gx-side .gx-sec{margin-top:12px;padding-top:10px;border-top:1px dashed #333;color:#aaa;font-size:.8rem;font-weight:800;letter-spacing:.04em}
.gx-side ol{margin:6px 0 0;padding-left:20px}.gx-side ol li{margin:4px 0;color:#ccc;cursor:pointer}.gx-side ol li.on{color:#fff;font-weight:700}
.gx-side pre{white-space:pre-wrap;font:inherit;color:#ddd;margin:6px 0 0}
.gx-desc{text-align:center;color:#f2f2f2;font-size:.95rem;line-height:1.5;padding:8px 18px 0;min-height:2.2em;max-width:980px;margin:0 auto}
.gx-desc b{color:#e0b04a;margin-right:6px}
.gx-bar{display:flex;gap:8px;overflow-x:auto;padding:10px 16px;scrollbar-width:thin}
.gx-bar img{height:64px;width:64px;object-fit:cover;border-radius:4px;opacity:.45;cursor:pointer;flex:none;border:2px solid transparent}
.gx-bar img.on{opacity:1;border-color:#e0b04a}
.gx-act{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:0 16px 14px}
.gx-act a,.gx-act button{background:#26262c;color:#eee;border:0;border-radius:8px;padding:8px 12px;font-size:.85rem;text-decoration:none;cursor:pointer}
.gx-act a:hover,.gx-act button:hover{background:#3a3a44}
@media (max-width:820px){.gx-main{flex-direction:column;padding:0 4px;flex:none}.gx-stage{flex:none;height:min(96vw,50vh)}.gx{overflow-y:auto}.gx-desc{font-size:.85rem}.gx-side{max-height:none}.gx-side{width:auto;max-width:none;max-height:32vh}.gx-nav{width:42px;height:42px;font-size:20px}.gx-bar img{height:52px;width:52px}}
`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const box = document.createElement('div'); box.className = 'gx'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  box.innerHTML = `<div class="gx-top"><div class="gx-ttl"></div><div class="gx-cnt"></div><button class="gx-x" aria-label="닫기">×</button></div>
<div class="gx-main"><div class="gx-stage"><button class="gx-nav gx-prev" aria-label="이전">‹</button><img alt=""><button class="gx-nav gx-next" aria-label="다음">›</button></div><div class="gx-side"></div></div>
<div class="gx-desc"></div><div class="gx-dots"></div><div class="gx-bar"></div><div class="gx-act"></div>`;
  document.body.appendChild(box);
  const $ = (s) => box.querySelector(s);
  const img = $('.gx-stage img'), side = $('.gx-side');
  let S = [], k = 0, cur = null;

  const sets = [];
  document.querySelectorAll('article').forEach((art) => {
    const links = [...art.querySelectorAll('.strip a, .set a')].filter((a) => /\.(jpe?g|png)$/i.test(a.getAttribute('href') || ''));
    if (!links.length) return;
    const set = {
      art, title: (art.querySelector('.inst')?.textContent || '') + ' — ' + (art.querySelector('h3')?.textContent || ''),
      slides: links.map((a) => ({ full: a.getAttribute('href'), thumb: a.querySelector('img')?.getAttribute('src') || a.getAttribute('href'), d: a.dataset.d || '' })),
      inst: art.querySelector('.inst')?.textContent || '', head: art.querySelector('h3')?.textContent || '',
      say: (art.querySelector('.q span') || art.querySelector('.q'))?.textContent.replace(/^"|"$/g, '') || '',
      facts: [...art.querySelectorAll('ul li')].map((li) => { const b = li.querySelector('b'); return [b ? b.textContent : '', b ? li.textContent.slice(b.textContent.length) : li.textContent]; }),
      tool: art.querySelector('.tool')?.textContent || '',
      extra: [...art.querySelectorAll('.lk a')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim(), dl: a.hasAttribute('download') })),
      cap: [...art.querySelectorAll('.lk a')].map((a) => a.getAttribute('href')).find((h) => /caption\.txt$/.test(h || '')),
    };
    sets.push(set);
    const idx = (href) => Math.max(0, set.slides.findIndex((s) => s.full === href));
    links.forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); open(set, idx(a.getAttribute('href'))); }));
    // 표지(첫 이미지)도 갤러리로
    const cov = art.querySelector(':scope > a > img, :scope > img');
    if (cov) {
      const host = cov.parentElement.tagName === 'A' ? cov.parentElement : cov;
      host.classList.add('gx-cov');
      host.addEventListener('click', (e) => { e.preventDefault(); open(set, 0); });
    }
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gx-open';
    b.textContent = `▶ 캐러셀 ${set.slides.length}장 넘겨 보기`;
    b.addEventListener('click', () => open(set, 0));
    const strip = art.querySelector('.strip, .set'); strip.parentElement.insertBefore(b, strip);
  });

  function open(set, i) {
    cur = set; S = set.slides; k = i;
    $('.gx-ttl').textContent = set.title;
    $('.gx-bar').innerHTML = S.map((s, j) => `<img src="${s.thumb}" data-j="${j}" alt="${j + 1}">`).join('');
    $('.gx-dots').innerHTML = S.map(() => '<i></i>').join('');
    const act = $('.gx-act'); act.innerHTML = '';
    { const b = document.createElement('button'); b.textContent = '📋 요약 닫기'; b.onclick = () => { b.textContent = side.classList.toggle('on') ? '📋 요약 닫기' : '📋 요약·소개글 보기'; }; act.appendChild(b); }
    const o = document.createElement('a'); o.textContent = '↗ 이 장 원본 크기'; o.target = '_blank'; o.className = 'gx-orig'; act.appendChild(o);
    set.extra.filter((x) => !/caption\.txt$/.test(x.href)).forEach((x) => { const a = document.createElement('a'); a.href = x.href; a.textContent = x.text; if (x.dl) a.setAttribute('download', ''); else { a.target = '_blank'; a.rel = 'noopener'; } act.appendChild(a); });
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    side.innerHTML = `<div class="gx-in">${esc(set.inst)}</div><h4>${esc(set.head)}</h4>`
      + (set.say ? `<div class="gx-q">"${esc(set.say)}"</div>` : '')
      + (set.facts.length ? '<dl>' + set.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v.trim())}</dd>`).join('') + '</dl>' : '')
      + (set.tool ? `<div class="gx-sec">찾은 경로</div><div style="color:#bbb;font-size:.82rem">${esc(set.tool)}</div>` : '')
      + (S.some((x) => x.d) ? '<div class="gx-sec">장별 내용</div><ol>' + S.map((x, j) => `<li data-j="${j}">${esc(x.d.split(' — ')[0] || (j + 1) + '장')}</li>`).join('') + '</ol>' : '')
      + (set.cap ? '<div class="gx-sec">소개글(인스타 캡션)</div><pre class="gx-cap">불러오는 중…</pre>' : '');
    side.classList.add('on');
    if (set.cap) fetch(set.cap).then((r) => r.text()).then((t) => { const el = side.querySelector('.gx-cap'); if (el && cur === set) el.textContent = t; }).catch(() => { const el = side.querySelector('.gx-cap'); if (el) el.textContent = '소개글을 불러오지 못했습니다.'; });
    if (matchMedia('(max-width:820px)').matches) { side.classList.remove('on'); act.firstChild.textContent = '📋 요약·소개글 보기'; }
    box.classList.add('on'); document.body.style.overflow = 'hidden';
    show();
  }
  function show() {
    img.style.opacity = .3; img.onload = () => { img.style.opacity = 1; }; img.src = S[k].full; img.alt = `${cur.title} ${k + 1}/${S.length}`;
    $('.gx-cnt').textContent = `${k + 1} / ${S.length}`;
    $('.gx-prev').disabled = k === 0; $('.gx-next').disabled = k === S.length - 1;
    box.querySelectorAll('.gx-bar img').forEach((t, j) => t.classList.toggle('on', j === k));
    box.querySelectorAll('.gx-dots i').forEach((t, j) => t.classList.toggle('on', j === k));
    box.querySelector('.gx-bar img.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    $('.gx-orig').href = S[k].full;
    const dd = S[k].d, cut = dd.indexOf(' — ');
    $('.gx-desc').innerHTML = dd ? `<b>${k + 1}. ${dd.slice(0, cut).replace(/</g, '&lt;')}</b>${dd.slice(cut + 3).replace(/</g, '&lt;')}` : '';
    side.querySelectorAll('ol li').forEach((t, j) => t.classList.toggle('on', j === k));
    [k - 1, k + 1].forEach((j) => { if (S[j]) new Image().src = S[j].full; }); // 이웃 장 미리 읽기
  }
  const go = (d) => { const n = k + d; if (n >= 0 && n < S.length) { k = n; show(); } };
  function close() { box.classList.remove('on'); document.body.style.overflow = ''; img.removeAttribute('src'); }
  $('.gx-prev').onclick = () => go(-1); $('.gx-next').onclick = () => go(1); $('.gx-x').onclick = close;
  side.addEventListener('click', (e) => { const j = e.target.dataset && e.target.dataset.j; if (j != null) { k = +j; show(); } });
  $('.gx-bar').addEventListener('click', (e) => { const j = e.target.dataset && e.target.dataset.j; if (j != null) { k = +j; show(); } });
  box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('gx-stage')) close(); });
  document.addEventListener('keydown', (e) => {
    if (!box.classList.contains('on')) return;
    if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'Escape') close();
  });
  let x0 = null, y0 = 0;
  const stage = $('.gx-stage');
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  }, { passive: true });
  // 주소 #s070 처럼 들어오면 그 시리즈 갤러리를 바로 연다(?view)
  if (/[?&]view\b/.test(location.search) && location.hash) {
    const s = sets.find((x) => '#' + x.art.id === location.hash); if (s) open(s, 0);
  }
})();
