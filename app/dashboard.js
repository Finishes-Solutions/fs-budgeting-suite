// Analytics Dashboard module (super_admin only).
// External IIFE — exposes window.FSDashboard, initialized from index.html.
(function(){
'use strict';

var adapter = {};
var data = null;
var loading = false;
var error = null;
var activityData = null;
var activityPage = 'summary';  // 'summary' = first 30, 'all' = paginated
var activityOffset = 0;
var SUMMARY_LIMIT = 30;
// 50 a click: enough to be worth the press, small enough that the table stays
// something you can actually read.
var PAGE_SIZE = 50;
var range = 30;                // days shown in the activity chart; 0 = all

function esc(s){ return adapter.esc ? adapter.esc(String(s)) : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function money(n){
  if(n==null||isNaN(n)) return '--';
  return '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});
}
function pct(n){
  if(n==null||isNaN(n)) return '--';
  return (Number(n)*100).toFixed(2)+'%';
}
function num(n){
  if(n==null||isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US');
}
function relTime(iso){
  if(!iso) return '--';
  var d=new Date(iso);
  var now=Date.now();
  var diff=now-d.getTime();
  if(diff<60000) return 'Just now';
  if(diff<3600000) return Math.floor(diff/60000)+'m ago';
  if(diff<86400000) return Math.floor(diff/3600000)+'h ago';
  if(diff<2592000000) return Math.floor(diff/86400000)+'d ago';
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function fmtDate(iso){
  if(!iso) return '--';
  return new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
}

function eventLabel(ev){
  var map={
    login:'Login',budget_create:'Budget Created',budget_save:'Budget Save',
    budget_delete:'Budget Delete',budget_restore:'Budget Restore',
    budget_status:'Budget Status',budget_primary:'Primary Budget Changed',
    budget_approve:'Budget Approved',
    analysis_save:'Analysis Save',
    analysis_delete:'Analysis Delete',analysis_restore:'Analysis Restore',
    project_create:'Project Created',project_update:'Project Updated',
    project_status:'Project Status',project_convert:'Project Converted',
    project_delete:'Project Deleted',project_entity:'Project Entity Changed',
    entity_create:'Entity Added',entity_update:'Entity Updated',
    favorite_add:'Favorited',favorite_remove:'Unfavorited',
    export_pdf:'PDF Export',export_xlsx:'Excel Export',export_csv:'CSV Export',
    export_print:'Print',settings_update:'Settings Update',
    profile_update:'Profile Updated',
    pricing_publish:'Pricing Publish'
  };
  return map[ev]||ev;
}

/* The activity log used to be able to say only WHAT KIND of thing happened.
   Every event now carries a structured detail document, and this turns it
   into the sentence a person actually wants: which budget, which project,
   which field, from what to what.

   Deliberately tolerant — an event written before its shape existed, or by a
   future version, renders as much as it can rather than as "[object Object]".
   Kept in step with the same function in app/home.js: one vocabulary, two
   places it is read. */
function usdish(n){
  return '$'+Math.round(Number(n)||0).toLocaleString('en-US');
}
function fieldPhrase(f){
  var k=f&&f.key?String(f.key):'';
  var pretty=k.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,function(c){return c.toUpperCase();});
  if(f && f.from!==undefined && f.to!==undefined && f.from!==null)
    return pretty+' '+String(f.from)+' → '+String(f.to);
  if(f && f.to!==undefined && f.to!==null) return pretty+' → '+String(f.to);
  return pretty;
}
function eventDetail(r){
  var d=r&&r.detail;
  if(!d||typeof d!=='object') return '';
  var name=d.name?String(d.name):'';
  var bits=[];
  switch(r.eventType){
    case 'favorite_add': case 'favorite_remove':
      return name?name:'';
    case 'budget_create': case 'budget_save':
      if(name) bits.push(name);
      if(d.projectKey) bits.push('on '+d.projectKey);
      if(d.versionNumber) bits.push('v'+d.versionNumber);
      if(Array.isArray(d.changed)&&d.changed.length)
        bits.push(d.changed.map(fieldPhrase).join('; '));
      else if(r.eventType==='budget_create')
        bits.push(usdish(d.projectCost)+' total project');
      return bits.join(' · ');
    case 'budget_status':
      return (name?name+' — ':'')+String(d.from)+' → '+String(d.to);
    case 'budget_delete':
      if(name) bits.push(name);
      if(d.projectKey) bits.push('on '+d.projectKey);
      if(d.projectCost!==undefined&&d.projectCost!==null) bits.push(usdish(d.projectCost)+' total project');
      return bits.join(' · ');
    case 'budget_primary':
      return (name?name+' — ':'')+(d.from||'none')+' → '+(d.to||'none');
    case 'project_create':
      return [name,d.address].filter(Boolean).join(' · ');
    case 'project_status':
      return (name?name+' — ':'')+String(d.from)+' → '+String(d.to);
    case 'project_convert':
      return (name?name+' — ':'')+'captured '+usdish(d.contractAmount)+' contract, '
        +usdish(d.projectAmount)+' project';
    case 'project_update':
      return (name?name+' — ':'')+(Array.isArray(d.fields)?d.fields.map(fieldPhrase).join('; '):'');
    case 'project_delete':
      return (name?name+' — ':'')+d.budgetsDeleted+' budget'+(d.budgetsDeleted===1?'':'s')
        +' and '+d.analysesDeleted+' analys'+(d.analysesDeleted===1?'is':'es')+' with it';
    case 'budget_approve':
      return (name?name+' — ':'')+(d.cleared?'approval cleared'
        :'approved version '+(d.versionNumber||'—')
          +(d.contractsFlagged?' · '+d.contractsFlagged+' contract'+(d.contractsFlagged===1?'':'s')+' to review':''));
    case 'project_entity':
      return (name?name+' — ':'')+'now '+(d.toLegalName||'no entity')
        +(d.contractsFlagged?' · '+d.contractsFlagged+' contract'+(d.contractsFlagged===1?'':'s')+' flagged for review':'');
    case 'entity_create': case 'entity_update':
      return [d.name,d.legalName].filter(Boolean).join(' · ')+(d.isActive===false?' (inactive)':'');
    case 'analysis_save':
      if(name) bits.push(name);
      if(d.budgetId) bits.push('from '+d.budgetId);
      if(d.versionNumber) bits.push('v'+d.versionNumber);
      return bits.join(' · ');
    case 'analysis_delete':
      if(name) bits.push(name);
      if(d.budgetId) bits.push('from '+d.budgetId);
      return bits.join(' · ');
    case 'profile_update':
      return Array.isArray(d.fields)?d.fields.map(fieldPhrase).join('; '):'';
    case 'settings_update':
      if(!Array.isArray(d.changed)) return '';
      // The pre-granular shape was a bare list of key names.
      return d.changed.map(function(c){
        return typeof c==='string'?c.replace(/([a-z])([A-Z])/g,'$1 $2'):fieldPhrase(c);
      }).join('; ');
    default:
      if(name) return name;
      return '';
  }
}

/* Two vocabularies share this map. Budgets and analyses answer "is this
   document finished" (Draft · In Review · Completed · Cancelled); projects
   answer "where is this deal" (Lead → … → Converted to Project). The stale
   names the map used to carry — In Progress, Approved, Signature Needed — were
   never statuses this app sets, and are gone. */
var STATUS_COLORS={
  'Draft':'#6B7280','In Review':'#8A6116','Completed':'#16803C','Cancelled':'#C43C3C',
  'Lead':'#6B7280','Qualified':'#4D5457','Budgeting':'#2B579A','Proposal Sent':'#8A6116',
  'Awarded':'#1F9249','Converted to Project':'#006527','On Hold':'#8A6116','Lost':'#C43C3C'
};

function statusColor(s){ return STATUS_COLORS[s]||'#6B7280'; }

/* Converted projects — the work that actually became work. Both amounts are
   the snapshots taken at conversion, so this row does not move when someone
   edits a budget afterwards; the tiles say so, because a number nobody can
   explain is a number nobody trusts. */
function projectKPIs(){
  var p=data&&data.projects;
  if(!p||!p.available)return '';
  // Two tiles, not three: the converted COUNT is context for the money rather
  // than a headline of its own, so it rides in the sub-line. A third tile
  // pushed the tile grid onto another row for a number nobody reads first.
  // The sub-lines stay to ONE line each: a wrapped sub costs more height than
  // the tile it was folded into saved.
  return '<div class="dash-kpi"><div class="k">Converted Contract Amount</div><div class="v">'+money(p.convertedContractAmount)+'</div>'
    +'<div class="sub">'+num(p.converted)+' of '+num(p.total)+' converted</div></div>'
    +'<div class="dash-kpi"><div class="k">Converted Project Amount</div><div class="v">'+money(p.convertedProjectAmount)+'</div>'
    +'<div class="sub">Captured at conversion</div></div>';
}

function renderKPIs(el){
  if(!data){el.innerHTML='<div class="dash-loading">Loading dashboard data...</div>';return;}
  var b=data.budgets, a=data.analyses, u=data.users;
  el.innerHTML=
    '<div class="dash-kpi"><div class="k">Active Budgets</div><div class="v">'+num(b.active)+'</div>'
    +'<div class="sub">'+num(b.deleted)+' deleted</div></div>'
    +'<div class="dash-kpi"><div class="k">Total Contract Sum</div><div class="v">'+money(b.totalContractSum)+'</div>'
    +'<div class="sub">Across all active budgets</div></div>'
    +'<div class="dash-kpi"><div class="k">Total Project Cost</div><div class="v">'+money(b.totalProjectCost)+'</div>'
    +'<div class="sub">Across all active budgets</div></div>'
    +'<div class="dash-kpi"><div class="k">Active Analyses</div><div class="v">'+num(a.active)+'</div>'
    +'<div class="sub">'+num(a.total)+' total created</div></div>'
    +projectKPIs()
    // The three averages carry no sub-line of their own, but they still emit
    // the element: an empty .sub is what keeps every card's number on the same
    // baseline as its neighbours.
    +'<div class="dash-kpi"><div class="k">Avg Purchase Price</div><div class="v">'+money(a.avgPurchasePrice)+'</div><div class="sub"></div></div>'
    +'<div class="dash-kpi"><div class="k">Avg Year 1 NOI</div><div class="v">'+money(a.avgYear1NOI)+'</div><div class="sub"></div></div>'
    +'<div class="dash-kpi"><div class="k">Avg Equity IRR</div><div class="v">'+pct(a.avgIRR)+'</div><div class="sub"></div></div>'
    +'<div class="dash-kpi"><div class="k">Registered Users</div><div class="v">'+num(u.total)+'</div>'
    +'<div class="sub">'+num(u.totalLogins)+' total logins</div></div>';
}

function barHTML(breakdown, total){
  if(!breakdown||!breakdown.length) return '<div style="color:var(--ink-500);font-size:13px">No data</div>';
  var html='<div class="dash-bar-group">';
  breakdown.forEach(function(r){
    var w=total>0?Math.max(2,Math.round(r.count/total*100)):0;
    html+='<div class="dash-bar-row">'
      +'<span class="dash-bar-label">'+esc(r.status)+'</span>'
      +'<div class="dash-bar-track"><div class="dash-bar-fill" style="width:'+w+'%;background:'+statusColor(r.status)+'"></div></div>'
      +'<span class="dash-bar-count">'+r.count+'</span></div>';
  });
  return html+'</div>';
}

function renderBreakdowns(el){
  if(!data){el.innerHTML='';return;}
  var b=data.budgets, a=data.analyses;
  var pj=data.projects;
  el.innerHTML=
    '<div class="dash-card"><h3>Budget Status</h3>'+donutHTML(b.statusBreakdown)+'</div>'
    +'<div class="dash-card"><h3>Analysis Status</h3>'+donutHTML(a.statusBreakdown)+'</div>'
    +(pj&&pj.available ? pipelineHTML(pj) : '');
}

/* The pipeline as a single proportional bar spanning both donut columns: a
   distribution, read left to right in PIPELINE order — the shape of a pipeline
   is the information, and sorting it by count destroys that. Stages with
   nothing in them are dropped from the bar (a zero-width segment is not a
   fact anyone can see) but the order of the rest is preserved. */
function pipelineHTML(p){
  var rows=pipelineRows(p).filter(function(r){return r.count>0;});
  var total=rows.reduce(function(s,r){return s+r.count;},0);
  if(!total) return '<div class="dash-card dash-span"><h3>Project Pipeline</h3>'
    +'<div class="dash-empty-inline">No projects yet.</div></div>';
  // The legend rides on the title line rather than under the bar: it costs a
  // whole row otherwise, and this card is buying its height from a neighbour.
  return '<div class="dash-card dash-span">'
    +'<div class="dash-pipe-hd"><h3>Project Pipeline</h3>'
    +'<div class="dash-legend dash-legend-h">'
    +rows.map(function(r){
      return '<span class="dash-lg-row"><span class="dash-lg-dot" style="background:'+statusColor(r.status)+'"></span>'
        +'<span class="dash-lg-name">'+esc(r.status)+'</span>'
        +'<span class="dash-lg-val">'+num(r.count)+'</span></span>';
    }).join('')
    +'</div></div>'
    +'<div class="dash-pipe">'
    +rows.map(function(r){
      return '<span class="dash-pipe-seg" style="flex:'+r.count+';background:'+statusColor(r.status)+'"'
        +' title="'+esc(r.status)+': '+num(r.count)+'"></span>';
    }).join('')
    +'</div></div>';
}

/* The pipeline in its real order rather than sorted by count — the shape of a
   pipeline is the information, and re-ordering destroys it. donutHTML renders
   segments in the order it is given, so the ring and its legend both read Lead
   first and Lost last. Using the same primitive as the two breakdowns beside it
   is not only consistent: a taller bespoke chart pushed the whole visual half
   of the dashboard past one screen, which suite-16 pins. */
function pipelineRows(p){
  var by={};(p.statusBreakdown||[]).forEach(function(r){by[r.status]=r.count;});
  return (p.statuses||[]).map(function(s){return {status:s,count:by[s]||0};});
}

/* ================= charts =================
   Hand-built inline SVG rather than a charting library: the app ships no
   bundler and the export path is the browser's own print pipeline, where SVG
   renders as vector and stays sharp in the PDF. Every chart is pure geometry
   over the API payload — no canvas, no external requests. */

var AXIS='#939a9d', GRID='#e8ebeb';

// Polar helper for the donut arcs: SVG arcs need endpoint coordinates, and
// starting at 12 o'clock reads more naturally than SVG's 3 o'clock zero.
function polar(cx,cy,r,frac){
  var t=(frac*2*Math.PI)-Math.PI/2;
  return [cx+r*Math.cos(t), cy+r*Math.sin(t)];
}

function donutHTML(breakdown){
  var rows=(breakdown||[]).filter(function(r){return r.count>0;});
  var total=rows.reduce(function(s,r){return s+r.count;},0);
  if(!total) return '<div style="color:var(--ink-500);font-size:13px;padding:8px 0">No data</div>';
  var cx=78,cy=78,rOut=70,rIn=44,acc=0,arcs='';
  rows.forEach(function(r){
    var frac=r.count/total, start=acc; acc+=frac;
    var col=statusColor(r.status);
    // A single slice covering the whole ring cannot be drawn as one arc
    // (start and end coincide), so it becomes two rings instead.
    if(rows.length===1){
      arcs='<circle cx="'+cx+'" cy="'+cy+'" r="'+((rOut+rIn)/2)+'" fill="none" stroke="'+col+'" stroke-width="'+(rOut-rIn)+'"/>';
      return;
    }
    var p1=polar(cx,cy,rOut,start), p2=polar(cx,cy,rOut,acc);
    var p3=polar(cx,cy,rIn,acc),   p4=polar(cx,cy,rIn,start);
    var big=frac>0.5?1:0;
    arcs+='<path d="M'+p1[0].toFixed(2)+' '+p1[1].toFixed(2)
      +'A'+rOut+' '+rOut+' 0 '+big+' 1 '+p2[0].toFixed(2)+' '+p2[1].toFixed(2)
      +'L'+p3[0].toFixed(2)+' '+p3[1].toFixed(2)
      +'A'+rIn+' '+rIn+' 0 '+big+' 0 '+p4[0].toFixed(2)+' '+p4[1].toFixed(2)
      +'Z" fill="'+col+'"><title>'+esc(r.status)+': '+r.count+'</title></path>';
  });
  var legend=rows.map(function(r){
    return '<div class="dash-lg-row"><span class="dash-lg-dot" style="background:'+statusColor(r.status)+'"></span>'
      +'<span class="dash-lg-name">'+esc(r.status)+'</span>'
      +'<span class="dash-lg-val">'+r.count+'</span>'
      +'<span class="dash-lg-pct">'+Math.round(r.count/total*100)+'%</span></div>';
  }).join('');
  return '<div class="dash-donut-wrap">'
    +'<svg viewBox="0 0 156 156" class="dash-donut" role="img" aria-label="Status breakdown">'
    +arcs
    +'<text x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle" class="dash-donut-n">'+total+'</text>'
    +'<text x="'+cx+'" y="'+(cy+14)+'" text-anchor="middle" class="dash-donut-l">TOTAL</text>'
    +'</svg><div class="dash-legend">'+legend+'</div></div>';
}

/* The six things worth watching, in the order they read: what people did,
   then what appeared, then what went away. Colours are far enough apart to
   tell six lines apart at a glance, and each one keeps its meaning across the
   chart, the legend and the hover readout. */
var SERIES=[
  {key:'saves',           name:'Saves',            color:'#006527'},
  {key:'logins',          name:'Logins',           color:'#2B579A'},
  {key:'budgetsCreated',  name:'Budgets Created',  color:'#0E8C8C'},
  {key:'analysesCreated', name:'Analyses Created', color:'#7C3AED'},
  {key:'budgetsDeleted',  name:'Budgets Deleted',  color:'#C43C3C'},
  {key:'analysesDeleted', name:'Analyses Deleted', color:'#D98A16'}
];

// Fills the gaps: the API only returns days that saw something, but a trend
// line with missing days would compress quiet periods and misread the shape.
// days = 0 means every day from the first record to today.
function fillDays(series, days){
  var byDay={};
  (series||[]).forEach(function(r){ byDay[r.day]=r; });
  var today=new Date(); today.setUTCHours(0,0,0,0);
  if(!days){
    var keys=Object.keys(byDay).sort();
    if(!keys.length) days=1;
    else {
      var first=new Date(keys[0]+'T00:00:00Z').getTime();
      days=Math.max(1, Math.round((today.getTime()-first)/86400000)+1);
    }
  }
  var out=[];
  for(var i=days-1;i>=0;i--){
    var t=new Date(today.getTime()-i*86400000);
    var key=t.toISOString().slice(0,10);
    var r=byDay[key]||{};
    var row={day:key, total:r.total||0};
    SERIES.forEach(function(sx){ row[sx.key]=r[sx.key]||0; });
    out.push(row);
  }
  return out;
}

function linePath(pts){
  return pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ');
}

/* Hover data for the chart, stashed where the mousemove handler can reach it
   without re-deriving the geometry. */
var chartHover=null;

function lineChartHTML(series, days){
  var rows=fillDays(series, days);
  // The viewBox aspect is the rendered aspect — no preserveAspectRatio games,
  // which stretch the axis type along with the lines.
  var W=1000,H=180,padL=40,padR=14,padT=10,padB=22;
  var iw=W-padL-padR, ih=H-padT-padB;
  var max=1;
  rows.forEach(function(d){ SERIES.forEach(function(sx){ max=Math.max(max,d[sx.key]||0); }); });
  // Round the axis up to something readable rather than the raw maximum.
  var step=Math.max(1,Math.ceil(max/3)), top=step*3;
  var x=function(i){return padL+(rows.length<2?iw/2:(i/(rows.length-1))*iw);};
  var y=function(v){return padT+ih-(v/top)*ih;};

  var grid='',labels='';
  for(var g=0;g<=3;g++){
    var gv=step*g, gy=y(gv);
    grid+='<line x1="'+padL+'" y1="'+gy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+gy.toFixed(1)+'" stroke="'+GRID+'" stroke-width="1"/>';
    labels+='<text x="'+(padL-8)+'" y="'+(gy+4).toFixed(1)+'" text-anchor="end" class="dash-ax">'+gv+'</text>';
  }
  // Roughly eight date ticks whatever the range, or they collide.
  var every=Math.max(1,Math.ceil(rows.length/8));
  var ticks='';
  rows.forEach(function(d,i){
    if(i%every!==0 && i!==rows.length-1) return;
    ticks+='<text x="'+x(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle" class="dash-ax">'
      +d.day.slice(5).replace('-','/')+'</text>';
  });

  var lines=SERIES.map(function(sx){
    var pts=rows.map(function(d,i){return [x(i),y(d[sx.key])];});
    // A single day has no line to draw, so it shows as a dot instead.
    if(rows.length===1){
      return '<circle cx="'+pts[0][0].toFixed(1)+'" cy="'+pts[0][1].toFixed(1)+'" r="4" fill="'+sx.color+'"/>';
    }
    return '<path d="'+linePath(pts)+'" fill="none" stroke="'+sx.color+'" stroke-width="2" '
      +'stroke-linejoin="round" stroke-linecap="round"/>';
  }).join('');

  var legend=SERIES.map(function(sx){
    return '<div class="dash-lg-row"><span class="dash-lg-dot" style="background:'+sx.color+'"></span>'
      +'<span class="dash-lg-name">'+sx.name+'</span></div>';
  }).join('');

  // Geometry the hover handler needs, rather than a second copy of the same
  // constants that could drift out of step with these.
  chartHover={rows:rows, W:W, padL:padL, iw:iw, xOf:x, yOf:y};

  return '<div class="dash-chart-wrap" id="dashChartWrap">'
    +'<svg viewBox="0 0 '+W+' '+H+'" class="dash-line" role="img" '
    +'aria-label="Activity by day">'
    +grid+labels+ticks
    +'<line id="dashGuide" x1="0" y1="'+padT+'" x2="0" y2="'+(padT+ih)+'" stroke="'+AXIS+'" '
    +'stroke-width="1" stroke-dasharray="3 3" style="display:none"/>'
    +lines
    +'<g id="dashHoverDots"></g>'
    +'</svg>'
    +'<div class="dash-tip" id="dashTip" style="display:none"></div>'
    +'</div>'
    +'<div class="dash-legend dash-legend-h">'+legend+'</div>';
}

/* Turns a pointer position into the day under it and paints the readout: a
   guide line, a dot on every series, and a panel of the six values. Hover on a
   chart should answer "what is that spike", which a static picture cannot. */
function chartMove(ev){
  var wrap=document.getElementById('dashChartWrap');
  var svg=wrap&&wrap.querySelector('svg');
  var tip=document.getElementById('dashTip');
  var guide=document.getElementById('dashGuide');
  var dots=document.getElementById('dashHoverDots');
  if(!wrap||!svg||!chartHover||!tip) return;
  var box=svg.getBoundingClientRect();
  var vb=svg.viewBox.baseVal;
  var sx=vb.width/box.width;
  var vx=(ev.clientX-box.left)*sx;
  var n=chartHover.rows.length;
  var frac=n<2?0:(vx-chartHover.padL)/chartHover.iw;
  var i=Math.max(0,Math.min(n-1,Math.round(frac*(n-1))));
  var row=chartHover.rows[i];
  var gx=chartHover.xOf(i);

  guide.setAttribute('x1',gx); guide.setAttribute('x2',gx); guide.style.display='';
  dots.innerHTML=SERIES.map(function(s2){
    var cy=chartHover.yOf(row[s2.key]||0);
    return '<circle cx="'+gx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="3.4" fill="'+s2.color+'" '
      +'stroke="#fff" stroke-width="1.2"/>';
  }).join('');

  tip.innerHTML='<div class="dash-tip-d">'+esc(fmtDay(row.day))+'</div>'
    +SERIES.map(function(s2){
      return '<div class="dash-tip-r"><span class="dash-lg-dot" style="background:'+s2.color+'"></span>'
        +'<span class="dash-tip-k">'+s2.name+'</span>'
        +'<span class="dash-tip-v">'+(row[s2.key]||0)+'</span></div>';
    }).join('');
  tip.style.display='block';
  // Keep the panel inside the card rather than letting it run off the edge.
  var left=gx/sx+14;
  if(left+tip.offsetWidth>box.width-6) left=gx/sx-tip.offsetWidth-14;
  tip.style.left=Math.max(4,left)+'px';
  tip.style.top='8px';
}

function chartLeave(){
  var tip=document.getElementById('dashTip');
  var guide=document.getElementById('dashGuide');
  var dots=document.getElementById('dashHoverDots');
  if(tip) tip.style.display='none';
  if(guide) guide.style.display='none';
  if(dots) dots.innerHTML='';
}

function fmtDay(iso){
  var d=new Date(iso+'T00:00:00Z');
  return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
}

/* The ranking the KPI tiles cannot show: which projects actually carry the
   money, and how much of the total each one is. Deliberately one metric —
   total project cost — where Budgets By Value compares two. */
function topProjectsHTML(rows){
  rows=(rows||[]).filter(function(r){return (r.projectCost||0)>0;})
    .slice().sort(function(a,b){return (b.projectCost||0)-(a.projectCost||0);}).slice(0,5);
  if(!rows.length) return '<div style="color:var(--ink-500);font-size:13px;padding:8px 0">No budgets yet</div>';
  var max=rows[0].projectCost||1;
  var all=(data&&data.budgets&&data.budgets.totalProjectCost)||rows.reduce(function(s,r){return s+(r.projectCost||0);},0);
  var html='<div class="dash-rank">';
  rows.forEach(function(r,i){
    var w=Math.max(2,Math.round((r.projectCost||0)/max*100));
    var share=all>0?Math.round((r.projectCost||0)/all*100):0;
    html+='<div class="dash-rank-row" title="'+esc(r.name||'Untitled')+' — '+money(r.projectCost)
      +' ('+share+'% of all project cost)">'
      +'<span class="dash-rank-n">'+(i+1)+'</span>'
      +'<span class="dash-rank-id mono">'+esc(r.projectId)+'</span>'
      +'<span class="dash-rank-nm">'+esc(r.name||'Untitled')+'</span>'
      +'<div class="dash-rank-track"><div class="dash-rank-fill" style="width:'+w+'%"></div></div>'
      +'<span class="dash-rank-v mono">'+money(r.projectCost)+'</span>'
      +'<span class="dash-rank-p">'+share+'%</span></div>';
  });
  return html+'</div>';
}

function budgetValueChartHTML(rows){
  rows=(rows||[]).filter(function(r){return (r.projectCost||0)>0||(r.contractSum||0)>0;}).slice(0,5);
  if(!rows.length) return '<div style="color:var(--ink-500);font-size:13px;padding:8px 0">No budgets yet</div>';
  var max=rows.reduce(function(m,r){return Math.max(m,r.projectCost||0,r.contractSum||0);},0)||1;
  var html='<div class="dash-vbars">';
  rows.forEach(function(r){
    var cw=Math.max(1,Math.round((r.contractSum||0)/max*100));
    var pw=Math.max(1,Math.round((r.projectCost||0)/max*100));
    html+='<div class="dash-vbar">'
      +'<div class="dash-vbar-hd"><span class="mono">'+esc(r.projectId)+'</span>'
      +'<span class="dash-vbar-nm">'+esc(r.name||'Untitled')+'</span></div>'
      +'<div class="dash-vbar-row"><span class="dash-vbar-k">Contract</span>'
      +'<div class="dash-vbar-track"><div class="dash-vbar-fill" style="width:'+cw+'%;background:#0a7a36"></div></div>'
      +'<span class="dash-vbar-v mono">'+money(r.contractSum)+'</span></div>'
      +'<div class="dash-vbar-row"><span class="dash-vbar-k">Project</span>'
      +'<div class="dash-vbar-track"><div class="dash-vbar-fill" style="width:'+pw+'%;background:#006527"></div></div>'
      +'<span class="dash-vbar-v mono">'+money(r.projectCost)+'</span></div>'
      +'</div>';
  });
  return html+'</div>';
}

var RANGE_TITLE={1:'Activity — Today',7:'Activity — Last 7 Days',
  14:'Activity — Last 14 Days',30:'Activity — Last 30 Days',0:'Activity — All Time'};

function renderCharts(){
  var trend=document.getElementById('dashTrend');
  var value=document.getElementById('dashValue');
  var top=document.getElementById('dashTop');
  var title=document.getElementById('dashTrendTitle');
  if(title) title.textContent=RANGE_TITLE[range]||RANGE_TITLE[30];
  if(trend){
    trend.innerHTML=data?lineChartHTML(data.activityByDay, range):'';
    var wrap=document.getElementById('dashChartWrap');
    if(wrap){
      wrap.addEventListener('mousemove',chartMove);
      wrap.addEventListener('mouseleave',chartLeave);
    }
  }
  if(value) value.innerHTML=data?budgetValueChartHTML(data.topBudgets):'';
  if(top) top.innerHTML=data?topProjectsHTML(data.topBudgets):'';
  var note=document.getElementById('dashTopNote');
  if(note&&data) note.textContent='Share of '+money(data.budgets.totalProjectCost)+' total project cost';
  document.querySelectorAll('#page-dashboard .dash-range').forEach(function(b){
    b.classList.toggle('on', Number(b.dataset.range)===range);
  });
}

function setRange(d){
  range=Number(d)||0;
  chartLeave();
  renderCharts();
}

function renderActivity(){
  var body=document.getElementById('dashActivityBody');
  var empty=document.getElementById('dashActivityEmpty');
  var viewBtn=document.getElementById('dashViewAllBtn');
  if(!body)return;

  var events=[];
  var total=0;
  if(activityPage==='summary' && data && data.recentActivity){
    events=data.recentActivity.slice(0, SUMMARY_LIMIT);
    total=data.recentActivity.length;
  } else if(activityPage==='all' && activityData){
    events=activityData.events||[];
    total=activityData.total||0;
  }

  if(!events.length){
    body.innerHTML='';
    if(empty) empty.style.display='block';
    if(viewBtn) viewBtn.style.display='none';
    return;
  }
  if(empty) empty.style.display='none';

  var html='';
  events.forEach(function(r){
    var det=eventDetail(r);
    html+='<tr><td style="padding-left:22px">'+esc(r.userName)+'</td>'
      +'<td>'+esc(eventLabel(r.eventType))+'</td>'
      +'<td class="mono">'+(r.entityId?esc((r.entityType||'')+' '+r.entityId):'<span style="color:var(--ink-400)">--</span>')+'</td>'
      +'<td class="act-detail">'+(det?esc(det):'<span style="color:var(--ink-400)">--</span>')+'</td>'
      +'<td class="mono r" style="padding-right:22px">'+esc(activityPage==='all'?fmtDate(r.createdAt):relTime(r.createdAt))+'</td></tr>';
  });
  body.innerHTML=html;

  if(activityPage==='summary'){
    viewBtn.style.display = total > SUMMARY_LIMIT ? '' : 'none';
    viewBtn.textContent = 'View More';
  } else {
    var remaining = total - (activityOffset + events.length);
    if(remaining>0){
      viewBtn.style.display='';
      viewBtn.textContent='View More (' + remaining + ' remaining)';
    } else {
      viewBtn.style.display='none';
    }
  }
}

function populateUserFilter(users){
  var sel=document.getElementById('dashUserFilter');
  if(!sel||!users)return;
  var current=sel.value;
  sel.innerHTML='<option value="">All Users</option>';
  users.forEach(function(u){
    sel.innerHTML+='<option value="'+esc(u.userId)+'">'+esc(u.name)+'</option>';
  });
  if(current) sel.value=current;
}

function renderDashboard(){
  var kpis=document.getElementById('dashKpis');
  var breakdown=document.getElementById('dashBreakdowns');
  if(!kpis)return;
  if(error){
    kpis.innerHTML='<div class="dash-error">'+esc(error)+'</div>';
    if(breakdown) breakdown.innerHTML='';
    return;
  }
  if(loading&&!data){
    kpis.innerHTML='<div class="dash-loading">Loading dashboard data...</div>';
    return;
  }
  renderKPIs(kpis);
  renderBreakdowns(breakdown);
  renderCharts();
  renderActivity();
}

async function loadData(){
  loading=true; error=null;
  renderDashboard();
  try{
    var r=await fetch('/api/analytics');
    if(r.status===403){error='Access denied. The super_admin role is required.';renderDashboard();return;}
    if(!r.ok){error='Failed to load analytics (HTTP '+r.status+').';renderDashboard();return;}
    data=await r.json();
  }catch(e){
    error='Cannot reach the analytics API. The server may be offline.';
  }
  loading=false;
  activityPage='summary';
  activityOffset=0;
  // The filter is populated from the dashboard payload, not from the first
  // page of the log: before this it stayed empty until you had already paged
  // the log, so filtering — and therefore a filtered CSV — was impossible.
  if(data&&data.activityUsers) populateUserFilter(data.activityUsers);
  renderDashboard();
}

function buildActivityURL(limit, offset){
  var parts=['/api/analytics?scope=activity&limit='+limit+'&offset='+offset];
  var from=document.getElementById('dashDateFrom');
  var to=document.getElementById('dashDateTo');
  var user=document.getElementById('dashUserFilter');
  if(from&&from.value) parts.push('from='+encodeURIComponent(from.value+'T00:00:00Z'));
  if(to&&to.value) parts.push('to='+encodeURIComponent(to.value+'T23:59:59Z'));
  if(user&&user.value) parts.push('userId='+encodeURIComponent(user.value));
  return parts.join('&');
}

async function loadActivityPage(offset){
  try{
    var url=buildActivityURL(PAGE_SIZE, offset);
    var r=await fetch(url);
    if(!r.ok) return;
    var d=await r.json();
    if(offset===0){
      activityData=d;
      populateUserFilter(d.users);
    } else {
      activityData.events=activityData.events.concat(d.events);
      activityData.total=d.total;
    }
    activityOffset=offset;
    renderActivity();
  }catch(e){/* silently fail */}
}

/* One press, the next 50. The first press swaps the 30-row summary for the
   real, filtered log; every press after that appends a page. */
function viewMore(){
  if(activityPage==='summary'){
    activityPage='all';
    loadActivityPage(0);
  } else if(activityData){
    var nextOffset=activityOffset+activityData.events.length;
    if(nextOffset<activityData.total) loadActivityPage(nextOffset);
  }
}

function applyFilter(){
  activityPage='all';
  activityOffset=0;
  activityData=null;
  loadActivityPage(0);
}

async function exportCSV(){
  var from=document.getElementById('dashDateFrom');
  var to=document.getElementById('dashDateTo');
  var user=document.getElementById('dashUserFilter');
  try{
    var all=[];
    var offset=0;
    var batch=1000;
    while(true){
      // ?scope=activity on the analytics function — /api/analytics-activity
      // was never a real endpoint, so every export came back empty.
      var parts=['/api/analytics?scope=activity&limit='+batch+'&offset='+offset];
      if(from&&from.value) parts.push('from='+encodeURIComponent(from.value+'T00:00:00Z'));
      if(to&&to.value) parts.push('to='+encodeURIComponent(to.value+'T23:59:59Z'));
      if(user&&user.value) parts.push('userId='+encodeURIComponent(user.value));
      var r=await fetch(parts.join('&'));
      if(!r.ok) break;
      var d=await r.json();
      all=all.concat(d.events);
      if(all.length>=d.total) break;
      offset+=batch;
    }
    // Details rides in the export too: an audit trail that is only complete
    // on screen is not an audit trail.
    var csv='User,Event,Entity Type,Entity ID,Details,Timestamp\r\n';
    all.forEach(function(e){
      csv+='"'+csvSafe(e.userName)+'","'+csvSafe(eventLabel(e.eventType))+'","'+csvSafe(e.entityType||'')+'","'+csvSafe(e.entityId||'')+'","'+csvSafe(eventDetail(e))+'","'+csvSafe(e.createdAt||'')+'"\r\n';
    });
    var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url;
    a.download='activity-log-'+new Date().toISOString().slice(0,10)+'.csv';
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }catch(e){
    alert('Export failed. Please try again.');
  }
}

function csvSafe(s){return String(s||'').replace(/"/g,'""');}

/* ---- Export Dashboard: a branded PDF snapshot ----
   Built through the app's existing print pipeline (a purpose-made document in
   #printDoc, never a picture of the screen), so it carries the same logo
   lockup, eyebrow and timestamp as the budget and analysis PDFs. The charts
   are the same SVG the page renders, which prints as vector. */
function exportPDF(){
  if(!data){ alert('The dashboard is still loading.'); return; }
  var host=document.getElementById('printDoc');
  if(!host||!adapter.print){ alert('Export is unavailable on this page.'); return; }

  var stamp=adapter.stamp?adapter.stamp():new Date().toLocaleString();
  var b=data.budgets,a=data.analyses,u=data.users;
  var kpi=function(k,v,s){
    return '<div class="dpdf-kpi"><div class="dpdf-k">'+esc(k)+'</div><div class="dpdf-v">'+esc(v)+'</div>'
      +(s?'<div class="dpdf-s">'+esc(s)+'</div>':'')+'</div>';
  };

  var rows=(activityPage==='all'&&activityData?activityData.events:(data.recentActivity||[])).slice(0,30);
  var log=rows.map(function(r){
    return '<tr><td>'+esc(r.userName)+'</td><td>'+esc(eventLabel(r.eventType))+'</td>'
      +'<td class="mono">'+(r.entityId?esc((r.entityType||'')+' '+r.entityId):'--')+'</td>'
      +'<td>'+esc(eventDetail(r)||'--')+'</td>'
      +'<td class="mono r">'+esc(fmtDate(r.createdAt))+'</td></tr>';
  }).join('');

  var filters=[];
  var uf=document.getElementById('dashUserFilter');
  var df=document.getElementById('dashDateFrom');
  var dt=document.getElementById('dashDateTo');
  if(uf&&uf.value&&uf.selectedIndex>0) filters.push('User: '+uf.options[uf.selectedIndex].text);
  if(df&&df.value) filters.push('From '+df.value);
  if(dt&&dt.value) filters.push('To '+dt.value);

  var html=''
    +'<header class="rpt-hd"><img src="assets/finishes-logo-black.png" alt="Finishes Solutions">'
    +'<div class="rpt-hd-r"><div class="eyebrow">Analytics snapshot</div>'
    +'<div class="mono stamp">'+esc(stamp)+'</div></div></header>'
    +'<section class="rpt-title"><div class="eyebrow">Platform analytics</div>'
    +'<h1>Analytics Dashboard</h1>'
    +'<div class="rpt-meta">Usage, budget and investment KPIs, and activity across all users'
    +(filters.length?' &middot; '+esc(filters.join(' · ')):'')+'</div></section>'

    +'<h2 class="dpdf-h">Key Figures</h2>'
    +'<div class="dpdf-kpis">'
    +kpi('Active Budgets',num(b.active),num(b.deleted)+' deleted')
    +kpi('Total Contract Sum',money(b.totalContractSum),'Across all active budgets')
    +kpi('Total Project Cost',money(b.totalProjectCost),'Across all active budgets')
    +kpi('Active Analyses',num(a.active),num(a.total)+' total created')
    +kpi('Avg Purchase Price',money(a.avgPurchasePrice),'')
    +kpi('Avg Year 1 NOI',money(a.avgYear1NOI),'')
    +kpi('Avg Equity IRR',pct(a.avgIRR),'')
    +kpi('Registered Users',num(u.total),num(u.totalLogins)+' total logins')
    +'</div>'

    +'<h2 class="dpdf-h">'+esc(RANGE_TITLE[range]||RANGE_TITLE[30])+'</h2>'
    +'<div class="dpdf-chart">'+lineChartHTML(data.activityByDay, range)+'</div>'

    +'<h2 class="dpdf-h">Status Breakdown</h2>'
    +'<div class="dpdf-two">'
    +'<div><h3 class="dpdf-h3">Budget Status</h3>'+donutHTML(b.statusBreakdown)+'</div>'
    +'<div><h3 class="dpdf-h3">Analysis Status</h3>'+donutHTML(a.statusBreakdown)+'</div>'
    +'</div>'

    +'<h2 class="dpdf-h">Budgets By Value</h2>'
    +'<div class="dpdf-chart">'+budgetValueChartHTML(data.topBudgets)+'</div>'

    +'<h2 class="dpdf-h">Top 5 Projects By Budget Amount</h2>'
    +'<div class="dpdf-chart">'+topProjectsHTML(data.topBudgets)+'</div>'

    +'<h2 class="dpdf-h">Activity Log</h2>'
    +(log
      ? '<table class="dpdf-tbl"><thead><tr><th>User</th><th>Event</th><th>Entity</th><th>Details</th><th class="r">When</th></tr></thead>'
        +'<tbody>'+log+'</tbody></table>'
        +'<div class="dpdf-note">Showing the '+rows.length+' most recent entries. '
        +'Use Export CSV on the dashboard for the complete, filtered log.</div>'
      : '<div class="dpdf-note">No activity recorded.</div>');

  adapter.print(html);
}

function refresh(){
  data=null; activityData=null; activityPage='summary'; activityOffset=0; loadData();
}

window.FSDashboard={
  init:function(a){ adapter=a||{}; },
  // Converting a project changes what the KPIs report, so the cache lets go
  // rather than showing yesterday's backlog until someone hits Refresh.
  invalidate:function(){ data=null; activityData=null; },
  render:function(){ if(!data&&!loading)loadData(); else renderDashboard(); },
  refresh:refresh,
  viewMore:viewMore,
  setRange:setRange,
  applyFilter:applyFilter,
  exportCSV:exportCSV,
  exportPDF:exportPDF
};
})();
