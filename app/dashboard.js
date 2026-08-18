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
var PAGE_SIZE = 100;

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
    login:'Login',budget_save:'Budget Save',budget_delete:'Budget Delete',
    budget_restore:'Budget Restore',analysis_save:'Analysis Save',
    analysis_delete:'Analysis Delete',analysis_restore:'Analysis Restore',
    export_pdf:'PDF Export',export_xlsx:'Excel Export',export_csv:'CSV Export',
    export_print:'Print',settings_update:'Settings Update',
    pricing_publish:'Pricing Publish'
  };
  return map[ev]||ev;
}

var STATUS_COLORS={
  'Draft':'#6B7280','In Progress':'#2B579A','Completed':'#16803C',
  'Approved':'#16803C','On Hold':'#8A6116','Cancelled':'#C43C3C',
  'Signature Needed':'#7C3AED'
};

function statusColor(s){ return STATUS_COLORS[s]||'#6B7280'; }

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
    +'<div class="dash-kpi"><div class="k">Avg Purchase Price</div><div class="v">'+money(a.avgPurchasePrice)+'</div></div>'
    +'<div class="dash-kpi"><div class="k">Avg Year 1 NOI</div><div class="v">'+money(a.avgYear1NOI)+'</div></div>'
    +'<div class="dash-kpi"><div class="k">Avg Equity IRR</div><div class="v">'+pct(a.avgIRR)+'</div></div>'
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
  el.innerHTML=
    '<div class="dash-card"><h3>Budget Status</h3>'+donutHTML(b.statusBreakdown)+'</div>'
    +'<div class="dash-card"><h3>Analysis Status</h3>'+donutHTML(a.statusBreakdown)+'</div>';
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

// Fills the gaps: the API only returns days that saw events, but a trend line
// with missing days would compress quiet periods and misread the shape.
function fillDays(series, days){
  var byDay={};
  (series||[]).forEach(function(r){ byDay[r.day]=r; });
  var out=[], d=new Date();
  d.setUTCHours(0,0,0,0);
  for(var i=days-1;i>=0;i--){
    var t=new Date(d.getTime()-i*86400000);
    var key=t.toISOString().slice(0,10);
    var r=byDay[key];
    out.push({day:key, total:r?r.total:0, logins:r?r.logins:0, saves:r?r.saves:0, exports:r?r.exports:0});
  }
  return out;
}

function linePath(pts){
  return pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ');
}

function lineChartHTML(series){
  var days=fillDays(series, 30);
  var W=440,H=190,padL=34,padR=8,padT=10,padB=24;
  var iw=W-padL-padR, ih=H-padT-padB;
  var max=Math.max(1, days.reduce(function(m,d){return Math.max(m,d.total);},0));
  // Round the axis up to something readable rather than the raw maximum.
  var step=Math.max(1,Math.ceil(max/3)), top=step*3;
  var x=function(i){return padL+(days.length<2?iw/2:(i/(days.length-1))*iw);};
  var y=function(v){return padT+ih-(v/top)*ih;};

  var grid='',labels='';
  for(var g=0;g<=3;g++){
    var gv=step*g, gy=y(gv);
    grid+='<line x1="'+padL+'" y1="'+gy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+gy.toFixed(1)+'" stroke="'+GRID+'" stroke-width="1"/>';
    labels+='<text x="'+(padL-8)+'" y="'+(gy+4).toFixed(1)+'" text-anchor="end" class="dash-ax">'+gv+'</text>';
  }
  // Date ticks only every 5th day, or they collide.
  var ticks='';
  days.forEach(function(d,i){
    if(i%10!==0 && i!==days.length-1) return;
    ticks+='<text x="'+x(i).toFixed(1)+'" y="'+(H-10)+'" text-anchor="middle" class="dash-ax">'
      +d.day.slice(5).replace('-','/')+'</text>';
  });

  var pts=days.map(function(d,i){return [x(i),y(d.total)];});
  var area='M'+padL+' '+(padT+ih)+' '+linePath(pts).slice(1)+' L'+(W-padR)+' '+(padT+ih)+' Z';
  var series2=[
    {key:'saves', color:'#0a7a36'},
    {key:'logins', color:'#2B579A'}
  ].map(function(s){
    var p=days.map(function(d,i){return [x(i),y(d[s.key])];});
    return '<path d="'+linePath(p)+'" fill="none" stroke="'+s.color+'" stroke-width="1.6" '
      +'stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round"/>';
  }).join('');

  var dots=days.map(function(d,i){
    return '<circle cx="'+x(i).toFixed(1)+'" cy="'+y(d.total).toFixed(1)+'" r="2.6" fill="#006527">'
      +'<title>'+d.day+': '+d.total+' events</title></circle>';
  }).join('');

  return '<div class="dash-chart-scroll"><svg viewBox="0 0 '+W+' '+H+'" class="dash-line" role="img" aria-label="Activity over the last 30 days">'
    +grid+labels+ticks
    +'<path d="'+area+'" fill="rgba(0,101,39,.10)"/>'
    +'<path d="'+linePath(pts)+'" fill="none" stroke="#006527" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>'
    +series2+dots
    +'</svg></div>'
    +'<div class="dash-legend dash-legend-h">'
    +'<div class="dash-lg-row"><span class="dash-lg-dot" style="background:#006527"></span><span class="dash-lg-name">All</span></div>'
    +'<div class="dash-lg-row"><span class="dash-lg-dot" style="background:#0a7a36"></span><span class="dash-lg-name">Saves</span></div>'
    +'<div class="dash-lg-row"><span class="dash-lg-dot" style="background:#2B579A"></span><span class="dash-lg-name">Logins</span></div>'
    +'</div>';
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

function renderCharts(){
  var trend=document.getElementById('dashTrend');
  var value=document.getElementById('dashValue');
  if(trend) trend.innerHTML=data?lineChartHTML(data.activityByDay):'';
  if(value) value.innerHTML=data?budgetValueChartHTML(data.topBudgets):'';
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
    html+='<tr><td style="padding-left:22px">'+esc(r.userName)+'</td>'
      +'<td>'+esc(eventLabel(r.eventType))+'</td>'
      +'<td class="mono">'+(r.entityId?esc((r.entityType||'')+' '+r.entityId):'<span style="color:var(--ink-400)">--</span>')+'</td>'
      +'<td class="mono r" style="padding-right:22px">'+esc(activityPage==='all'?fmtDate(r.createdAt):relTime(r.createdAt))+'</td></tr>';
  });
  body.innerHTML=html;

  if(activityPage==='summary'){
    viewBtn.style.display = total > SUMMARY_LIMIT ? '' : 'none';
    viewBtn.textContent = 'View All';
  } else {
    var hasMore = activityOffset + events.length < total;
    if(hasMore){
      viewBtn.style.display='';
      viewBtn.textContent='Load More (' + (total - activityOffset - events.length) + ' remaining)';
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

function viewAll(){
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
      var parts=['/api/analytics-activity?limit='+batch+'&offset='+offset];
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
    var csv='User,Event,Entity Type,Entity ID,Timestamp\r\n';
    all.forEach(function(e){
      csv+='"'+csvSafe(e.userName)+'","'+csvSafe(eventLabel(e.eventType))+'","'+csvSafe(e.entityType||'')+'","'+csvSafe(e.entityId||'')+'","'+csvSafe(e.createdAt||'')+'"\r\n';
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

    +'<h2 class="dpdf-h">Activity — Last 30 Days</h2>'
    +'<div class="dpdf-chart">'+lineChartHTML(data.activityByDay)+'</div>'

    +'<h2 class="dpdf-h">Status Breakdown</h2>'
    +'<div class="dpdf-two">'
    +'<div><h3 class="dpdf-h3">Budget Status</h3>'+donutHTML(b.statusBreakdown)+'</div>'
    +'<div><h3 class="dpdf-h3">Analysis Status</h3>'+donutHTML(a.statusBreakdown)+'</div>'
    +'</div>'

    +'<h2 class="dpdf-h">Budgets By Value</h2>'
    +'<div class="dpdf-chart">'+budgetValueChartHTML(data.topBudgets)+'</div>'

    +'<h2 class="dpdf-h">Activity Log</h2>'
    +(log
      ? '<table class="dpdf-tbl"><thead><tr><th>User</th><th>Event</th><th>Entity</th><th class="r">When</th></tr></thead>'
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
  render:function(){ if(!data&&!loading)loadData(); else renderDashboard(); },
  refresh:refresh,
  viewAll:viewAll,
  applyFilter:applyFilter,
  exportCSV:exportCSV,
  exportPDF:exportPDF
};
})();
