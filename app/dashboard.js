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
    '<div class="dash-card"><h3>Budget Status</h3>'+barHTML(b.statusBreakdown, b.active)+'</div>'
    +'<div class="dash-card"><h3>Analysis Status</h3>'+barHTML(a.statusBreakdown, a.active)+'</div>';
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
  var parts=['/api/analytics-activity?limit='+limit+'&offset='+offset];
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

function refresh(){
  data=null; activityData=null; activityPage='summary'; activityOffset=0; loadData();
}

window.FSDashboard={
  init:function(a){ adapter=a||{}; },
  render:function(){ if(!data&&!loading)loadData(); else renderDashboard(); },
  refresh:refresh,
  viewAll:viewAll,
  applyFilter:applyFilter,
  exportCSV:exportCSV
};
})();
