// Analytics Dashboard module (super_admin only).
// External IIFE — exposes window.FSDashboard, initialized from index.html.
(function(){
'use strict';

var adapter = {};
var data = null;
var loading = false;
var error = null;

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

function renderActivity(el){
  if(!data||!data.recentActivity||!data.recentActivity.length){
    el.innerHTML='<div style="color:var(--ink-500);font-size:13px;padding:12px 0">No recent activity</div>';
    return;
  }
  var html='<div style="overflow-x:auto"><table class="dash-activity"><thead><tr>'
    +'<th>User</th><th>Event</th><th>Entity</th><th class="r">When</th></tr></thead><tbody>';
  data.recentActivity.forEach(function(r){
    html+='<tr><td>'+esc(r.userName)+'</td>'
      +'<td>'+esc(eventLabel(r.eventType))+'</td>'
      +'<td class="mono">'+(r.entityId?esc(r.entityType+' '+r.entityId):'--')+'</td>'
      +'<td class="mono" style="text-align:right">'+esc(relTime(r.createdAt))+'</td></tr>';
  });
  html+='</tbody></table></div>';
  el.innerHTML=html;
}

function renderDashboard(){
  var kpis=document.getElementById('dashKpis');
  var breakdown=document.getElementById('dashBreakdowns');
  var activity=document.getElementById('dashActivity');
  if(!kpis)return;
  if(error){
    kpis.innerHTML='<div class="dash-error">'+esc(error)+'</div>';
    breakdown.innerHTML='';
    activity.innerHTML='';
    return;
  }
  if(loading&&!data){
    kpis.innerHTML='<div class="dash-loading">Loading dashboard data...</div>';
    return;
  }
  renderKPIs(kpis);
  renderBreakdowns(breakdown);
  renderActivity(activity);
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
  renderDashboard();
}

function refresh(){
  data=null; loadData();
}

window.FSDashboard={
  init:function(a){ adapter=a||{}; },
  render:function(){ if(!data&&!loading)loadData(); else renderDashboard(); },
  refresh:refresh
};
})();
