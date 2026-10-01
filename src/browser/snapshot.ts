/**
 * The in-page snapshot script, carried over verbatim from jev-ultrafast
 * `jev_ultrafast/snapshot.js`
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser Use).
 *
 * It is embedded as a `String.raw` template on purpose: the code is injected into
 * the page as text, so it must not be bundled, transpiled or reformatted. The
 * upstream source contains no backtick and no `${`, which is what makes a raw
 * template a byte-faithful carrier; `tests/snapshot.test.ts` asserts that
 * property, so a future edit to the copy cannot silently break it.
 *
 * The one thing that is not upstream is the block below the control query: an element a page makes
 * clickable with its own script rather than with a control tag is offered as a candidate too. It
 * sits behind a single switch (`__JEV_DEEP_SCAN__`, substituted once for each of the two exports),
 * so `SNAPSHOT_SOURCE_PLAIN` is this same script with that block not running — the reading every
 * page had before it existed, byte for byte, and what the setting's "off" means.
 *
 * It runs as one expression and returns the whole page state: the indexed
 * element table, the visible text, the freshness marker, the per-node guards, and the
 * count of structures it could not reach into (see `./nested.ts`).
 *
 * The text it returns is deliberately viewport-only: the geometry test in the walker
 * drops every line that is off screen, and 6000 characters is the ceiling. Reading a
 * page that is longer than one screen therefore means collecting one screen at a time
 * and stitching them — `src/browser/read.ts` is where that is done. Do not widen the
 * walker instead: both callers must agree on what "the visible text" means, and the
 * decision request is sent that same text on every step.
 */
const SNAPSHOT_BODY = String.raw`(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  // The choices a popup offers — the autocomplete list under a field, a suggestion dropdown, a
  // picker — are usually plain markup: no control tag and no role, so nothing above names them and
  // the model reads their text in the page while having nothing to click. These are the shapes that
  // do name them, and only shapes that say what the item is: a row of a listbox, an item that
  // records its own selection, or a list row that carries its value in a data-* attribute.
  const choices='[aria-selected],[role="listbox"] li,[role="listbox"] [data-value],'+
    '[role="listbox"] [data-index],[role="listbox"] [data-key],[role="listbox"] [data-id],'+
    'ul li[data-value],ul li[data-index],ul li[data-key],ul li[data-id],ul li[data-code]';
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  // The nodes the control query above really offered — it is what tells the deep scan below which
  // elements the table already carries, so that nothing is offered twice.
  const offered=new Set();
  // A field can be driven on the keyboard as well as by typing, and that is not decoration: an
  // autocomplete list is often plain markup in a shape the selectors above still cannot name, so a
  // key stays the only way to pick from one. One action per key, so each gets its own target.
  const keys=['enter','escape','tab','arrowdown','arrowup'];
  for (const e of document.querySelectorAll(selector+','+choices)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    // A popup choice is not a native control, so its shape is what names it — an option again only
    // while it is shown and says something. A hidden list, a row kept for later, a row with no text
    // at all and a row scrolled out of view each fail one of these instead of spending a slot in the
    // element table; a row whose own click target is already listed — the anchor or button inside it
    // — is left to that element, the same way a gridcell holding a button is.
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, own=name(e),
      rname=role(e)||(e.matches(choices) && own.trim()!=='' ? 'option' : null);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    if (rname==='option' && !role(e) && e.querySelector('a[href],button,[role="button"]')) continue;
    offered.add(e);
    const base={node:identity(e),role:rname,label:own||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) {
        actions.push({...base,kind:'click',value,label:'Open '+base.label});
        for (const key of keys)
          actions.push({...base,kind:'press_key',key,value,label:base.label+' → '+key});
      }
    }
  }
  // ---- elements that are clickable only because the page's own script made them so ----
  //
  // Every selector above names a control by what it is: a tag the browser treats as one, or a role
  // the page declares. A site that hangs its own handler on a plain element — the shape React and Vue
  // reach for, where the listener is delegated from a root container and the markup says nothing —
  // leaves the model reading the words on the screen with nothing to click: on a hotel list that is
  // the row, and the 「预订」 that is the page's whole point.
  //
  // Three clues are asked, in the order of how much each one proves. All three are about the element
  // itself; what an element looks like is not asked at all. A cursor:pointer style was measured on the same
  // page as the rest of this and rejected as a source: 253 elements carry it inside one viewport and
  // 103 of them have a name, nearly all navigation icon slots, so it names decoration rather than
  // clickability, and it is not one of the three clues below.
  //
  //   1. getEventListeners(el): the browser's own answer to "does this node respond to a click", the
  //      same one the DevTools front end's Event Listeners pane shows. It reports only the listeners
  //      attached to that node, so a page that delegates from a root container answers no for every
  //      row it renders — measured on React 18.3.1, where the three rows of a list all answered false
  //      and only the root container answered true. It is a console API: the name is in scope only
  //      when the evaluation asked for it (includeCommandLineAPI, see ./session.ts) and is undefined
  //      otherwise — which is also how it is known to put nothing on the page, since an API installed
  //      on the page's own global object would answer either way.
  //   2. the inline on* attributes: listeners spelled in the markup, and the clue that still works
  //      where (1) is unavailable.
  //   3. the properties React 17+ and its older runtime leave on the elements they rendered
  //      (__reactProps$<key>, __reactEventHandlers$<key>). React keeps the handler in these props and
  //      attaches the listener to its root container, so the handler for a row sits on the row or a
  //      little way above it: walked at most REACT_UP levels up and never further, with the level it
  //      was found at written into the entry rather than thrown away, because "three levels up" is a
  //      weaker fact than "on this element". Walking to the root instead would make one container
  //      holding a whole page look like a candidate. This clue has no real-browser measurement behind
  //      it yet (the other two do), so it is the most conservative of the three.
  //
  // Four filters, all of them measured requirements rather than tidiness: visible by the rule above;
  // a centre inside the viewport, the same test the native controls get; a name to call it by; and
  // not a whole screen — the last one because the same measurement found every page's own BODY
  // (1105×780 inside a 1120×780 viewport) answering that it responds to clicks.
  //
  // An entry here is about 67 characters compact, so the allowance below is under 1k characters of
  // the request body and the table's own 48-entry cap is what really decides. That is why the pool is
  // capped, why it is appended after the native controls, and why the tie-break inside
  // trimActionSpace still prefers them: a guess only takes a slot from a control that reads as less
  // relevant to the goal's own words.
  if (__JEV_DEEP_SCAN__) {
    const GUESS_LIMIT=12, REACT_UP=3;
    const events=['click','mousedown','mouseup','pointerdown','pointerup','DOMActivate'];
    const inline=['onclick','onmousedown','onmouseup','onpointerdown','onpointerup'];
    const listeners=typeof getEventListeners==='function' ? getEventListeners : null;
    const reacts=e=>{
      for (const key of Object.keys(e)) {
        if (!key.startsWith('__reactProps$') && !key.startsWith('__reactEventHandlers$')) continue;
        const props=e[key];
        if (props && (typeof props.onClick==='function' || typeof props.onMouseDown==='function' ||
            typeof props.onMouseUp==='function' || typeof props.onPointerDown==='function')) return true;
      }
      return false;
    };
    // Which clue says this element is clickable, or '' when none of them does. The React clue carries
    // the level it was found at, so a run can tell a handler of its own from one three levels up.
    const clue=e=>{
      if (listeners && events.some(n=>((listeners(e)||{})[n]||[]).length>0)) return 'listener';
      if (inline.some(n=>e.getAttribute(n)!==null)) return 'inline';
      let at=e;
      for (let up=0; at && up<=REACT_UP; up+=1, at=at.parentElement)
        if (reacts(at)) return 'react'+up;
      return '';
    };
    // Whether this element holds something the native table already offers: the rule a gridcell
    // holding a button gets, for the same reason — the inner, named control is left to do the job.
    const holds=e=>{
      for (const child of e.childNodes)
        if (child.nodeType===1 && (offered.has(child) || holds(child))) return true;
      return false;
    };
    const kept=new Set();
    const insideKept=e=>{
      for (let p=e.parentElement; p; p=p.parentElement) if (kept.has(p)) return true;
      return false;
    };
    for (const e of document.querySelectorAll('*')) {
      if (kept.size>=GUESS_LIMIT) break;
      // The cheapest question first: the listener map is a lookup, while visibility and naming cost
      // style resolution and tree walks.
      if (offered.has(e)) continue;
      const found=clue(e);
      if (!found) continue;
      if (!safe(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]') || !visible(e)) continue;
      const r=e.getBoundingClientRect(), area=r.width*r.height;
      if (area<=0 || area>=innerWidth*innerHeight*0.8) continue;
      const x=r.x+r.width/2, y=r.y+r.height/2;
      if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
      const own=name(e).trim();
      if (!own || holds(e) || insideKept(e)) continue;
      const base={node:identity(e),role:role(e)||'button',label:own,guess:found,
        rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
      for (const key of ['checked','selected','expanded']) {
        const value=e.getAttribute('aria-'+key);
        if (value!==null) base[key]=value;
      }
      actions.push({...base,kind:'click',value:''});
      kept.add(e);
    }
  }
  // Structures every query above cannot reach into: a visible frame, and an open shadow
  // root with something in it. Counted here and turned into a sentence in TypeScript
  // (browser/nested.ts) — this script only reports what it saw. The element count is taken
  // before the synthetic scroll/wait actions are added, because the question the sentence
  // answers is whether the page itself offered anything to work with.
  const frames=[...document.querySelectorAll('iframe')].filter(e => {
    if (!visible(e)) return false;
    const r=e.getBoundingClientRect();
    return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth;
  });
  let shadow_roots=0, hosts=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT), host;
  while ((host=hosts.nextNode())) if (host.shadowRoot && host.shadowRoot.childElementCount>0) { shadow_roots=1; break; }
  const nested={frames:frames.length,frame_url:frames.map(f=>f.getAttribute('src')).find(s=>!!s)||'',
    shadow_roots,elements:actions.length};
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions,nested};
})()`

/**
 * The script as a run evaluates it, with the deep scan for script-made clickables on.
 *
 * The switch is substituted rather than passed, because the code is injected as one expression:
 * the off variant is then the same bytes with one word changed, which is what makes "off" the
 * reading this project had before the block existed rather than a second implementation of it.
 */
export const SNAPSHOT_SOURCE = SNAPSHOT_BODY.replace('__JEV_DEEP_SCAN__', 'true')

/** The same script with the deep scan off: the native controls alone, as every run read a page before. */
export const SNAPSHOT_SOURCE_PLAIN = SNAPSHOT_BODY.replace('__JEV_DEEP_SCAN__', 'false')
