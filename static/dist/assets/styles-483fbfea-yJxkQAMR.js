import{G as e,K as t,U as n,W as r}from"./RolloutPage-NJOEYD1z.js";import{t as i}from"./channel-43G4CbID.js";import{t as a}from"./graphlib-X9YV7s_5.js";import{t as o}from"./index-01f381cb-N9kNQ9l8.js";import{C as s,Et as c,L as l,Pt as u,R as d,T as f,Vt as p,_ as m,at as h,b as g,k as _,p as v,s as y}from"./mermaid.core-C7lXL98o.js";function b(n){return typeof n==`string`?new r([document.querySelectorAll(n)],[document.documentElement]):new r([t(n)],e)}function x(e,t){return!!e.children(t).length}function S(e){return w(e.v)+`:`+w(e.w)+`:`+w(e.name)}var C=/:/g;function w(e){return e?String(e).replace(C,`\\:`):``}function T(e,t){t&&e.attr(`style`,t)}function E(e,t,n){t&&e.attr(`class`,t).attr(`class`,n+` `+e.attr(`class`))}function D(e,t){var n=t.graph();if(h(n)){var r=n.transition;if(c(r))return r(e)}return e}function O(e,t){var n=e.append(`foreignObject`).attr(`width`,`100000`),r=n.append(`xhtml:div`);r.attr(`xmlns`,`http://www.w3.org/1999/xhtml`);var i=t.label;switch(typeof i){case`function`:r.insert(i);break;case`object`:r.insert(function(){return i});break;default:r.html(i)}T(r,t.labelStyle),r.style(`display`,`inline-block`),r.style(`white-space`,`nowrap`);var a=r.node().getBoundingClientRect();return n.attr(`width`,a.width).attr(`height`,a.height),n}var k={},A=function(e){let t=Object.keys(e);for(let n of t)k[n]=e[n]},j=async function(e,t,n,r,i,a){let o=r.select(`[id="${n}"]`),s=Object.keys(e);for(let n of s){let r=e[n],s=`default`;r.classes.length>0&&(s=r.classes.join(` `)),s+=` flowchart-label`;let c=g(r.styles),l=r.text===void 0?r.id:r.text,u;if(f.info(`vertex`,r,r.labelType),r.labelType===`markdown`)f.info(`vertex`,r,r.labelType);else if(v(m().flowchart.htmlLabels))u=O(o,{label:l}).node(),u.parentNode.removeChild(u);else{let e=i.createElementNS(`http://www.w3.org/2000/svg`,`text`);e.setAttribute(`style`,c.labelStyle.replace(`color:`,`fill:`));let t=l.split(y.lineBreakRegex);for(let n of t){let t=i.createElementNS(`http://www.w3.org/2000/svg`,`tspan`);t.setAttributeNS(`http://www.w3.org/XML/1998/namespace`,`xml:space`,`preserve`),t.setAttribute(`dy`,`1em`),t.setAttribute(`x`,`1`),t.textContent=n,e.appendChild(t)}u=e}let d=0,p=``;switch(r.type){case`round`:d=5,p=`rect`;break;case`square`:p=`rect`;break;case`diamond`:p=`question`;break;case`hexagon`:p=`hexagon`;break;case`odd`:p=`rect_left_inv_arrow`;break;case`lean_right`:p=`lean_right`;break;case`lean_left`:p=`lean_left`;break;case`trapezoid`:p=`trapezoid`;break;case`inv_trapezoid`:p=`inv_trapezoid`;break;case`odd_right`:p=`rect_left_inv_arrow`;break;case`circle`:p=`circle`;break;case`ellipse`:p=`ellipse`;break;case`stadium`:p=`stadium`;break;case`subroutine`:p=`subroutine`;break;case`cylinder`:p=`cylinder`;break;case`group`:p=`rect`;break;case`doublecircle`:p=`doublecircle`;break;default:p=`rect`}let h=await _(l,m());t.setNode(r.id,{labelStyle:c.labelStyle,shape:p,labelText:h,labelType:r.labelType,rx:d,ry:d,class:s,style:c.style,id:r.id,link:r.link,linkTarget:r.linkTarget,tooltip:a.db.getTooltip(r.id)||``,domId:a.db.lookUpDomId(r.id),haveCallback:r.haveCallback,width:r.type===`group`?500:void 0,dir:r.dir,type:r.type,props:r.props,padding:m().flowchart.padding}),f.info(`setNode`,{labelStyle:c.labelStyle,labelType:r.labelType,shape:p,labelText:h,rx:d,ry:d,class:s,style:c.style,id:r.id,domId:a.db.lookUpDomId(r.id),width:r.type===`group`?500:void 0,type:r.type,dir:r.dir,props:r.props,padding:m().flowchart.padding})}},M=async function(e,t,n){f.info(`abc78 edges = `,e);let r=0,i={},a,o;if(e.defaultStyle!==void 0){let t=g(e.defaultStyle);a=t.style,o=t.labelStyle}for(let n of e){r++;let c=`L-`+n.start+`-`+n.end;i[c]===void 0?(i[c]=0,f.info(`abc78 new entry`,c,i[c])):(i[c]++,f.info(`abc78 new entry`,c,i[c]));let l=c+`-`+i[c];f.info(`abc78 new link id to be used is`,c,l,i[c]);let u=`LS-`+n.start,d=`LE-`+n.end,h={style:``,labelStyle:``};switch(h.minlen=n.length||1,h.arrowhead=n.type===`arrow_open`?`none`:`normal`,h.arrowTypeStart=`arrow_open`,h.arrowTypeEnd=`arrow_open`,n.type){case`double_arrow_cross`:h.arrowTypeStart=`arrow_cross`;case`arrow_cross`:h.arrowTypeEnd=`arrow_cross`;break;case`double_arrow_point`:h.arrowTypeStart=`arrow_point`;case`arrow_point`:h.arrowTypeEnd=`arrow_point`;break;case`double_arrow_circle`:h.arrowTypeStart=`arrow_circle`;case`arrow_circle`:h.arrowTypeEnd=`arrow_circle`}let v=``,b=``;switch(n.stroke){case`normal`:v=`fill:none;`,a!==void 0&&(v=a),o!==void 0&&(b=o),h.thickness=`normal`,h.pattern=`solid`;break;case`dotted`:h.thickness=`normal`,h.pattern=`dotted`,h.style=`fill:none;stroke-width:2px;stroke-dasharray:3;`;break;case`thick`:h.thickness=`thick`,h.pattern=`solid`,h.style=`stroke-width: 3.5px;fill:none;`;break;case`invisible`:h.thickness=`invisible`,h.pattern=`solid`,h.style=`stroke-width: 0;fill:none;`}if(n.style!==void 0){let e=g(n.style);v=e.style,b=e.labelStyle}h.style=h.style+=v,h.labelStyle=h.labelStyle+=b,h.curve=n.interpolate===void 0?e.defaultInterpolate===void 0?s(k.curve,p):s(e.defaultInterpolate,p):s(n.interpolate,p),n.text===void 0?n.style!==void 0&&(h.arrowheadStyle=`fill: #333`):(h.arrowheadStyle=`fill: #333`,h.labelpos=`c`),h.labelType=n.labelType,h.label=await _(n.text.replace(y.lineBreakRegex,`
`),m()),n.style===void 0&&(h.style=h.style||`stroke: #333; stroke-width: 1.5px;fill:none;`),h.labelStyle=h.labelStyle.replace(`color:`,`fill:`),h.id=l,h.classes=`flowchart-link `+u+` `+d,t.setEdge(n.start,n.end,h,r)}},N={setConf:A,addVertices:j,addEdges:M,getClasses:function(e,t){return t.db.getClasses()},draw:async function(e,t,r,i){f.info(`Drawing flowchart`);let s=i.db.getDirection();s===void 0&&(s=`TD`);let{securityLevel:c,flowchart:u}=m(),p=u.nodeSpacing||50,h=u.rankSpacing||50,g;c===`sandbox`&&(g=n(`#i`+t));let _=n(c===`sandbox`?g.nodes()[0].contentDocument.body:`body`),v=c===`sandbox`?g.nodes()[0].contentDocument:document,y=new a({multigraph:!0,compound:!0}).setGraph({rankdir:s,nodesep:p,ranksep:h,marginx:0,marginy:0}).setDefaultEdgeLabel(function(){return{}}),x,S=i.db.getSubGraphs();f.info(`Subgraphs - `,S);for(let e=S.length-1;e>=0;e--)x=S[e],f.info(`Subgraph - `,x),i.db.addVertex(x.id,{text:x.title,type:x.labelType},`group`,void 0,x.classes,x.dir);let C=i.db.getVertices(),w=i.db.getEdges();f.info(`Edges`,w);let T=0;for(T=S.length-1;T>=0;T--){x=S[T],b(`cluster`).append(`text`);for(let e=0;e<x.nodes.length;e++)f.info(`Setting up subgraphs`,x.nodes[e],x.id),y.setParent(x.nodes[e],x.id)}await j(C,y,t,_,v,i),await M(w,y);let E=_.select(`[id="${t}"]`),D=_.select(`#`+t+` g`);if(await o(D,y,[`point`,`circle`,`cross`],`flowchart`,t),d.insertTitle(E,`flowchartTitleText`,u.titleTopMargin,i.db.getDiagramTitle()),l(y,E,u.diagramPadding,u.useMaxWidth),i.db.indexNodes(`subGraph`+T),!u.htmlLabels){let e=v.querySelectorAll(`[id="`+t+`"] .edgeLabel .label`);for(let t of e){let e=t.getBBox(),n=v.createElementNS(`http://www.w3.org/2000/svg`,`rect`);n.setAttribute(`rx`,0),n.setAttribute(`ry`,0),n.setAttribute(`width`,e.width),n.setAttribute(`height`,e.height),t.insertBefore(n,t.firstChild)}}Object.keys(C).forEach(function(e){let r=C[e];if(r.link){let i=n(`#`+t+` [id="`+e+`"]`);if(i){let e=v.createElementNS(`http://www.w3.org/2000/svg`,`a`);e.setAttributeNS(`http://www.w3.org/2000/svg`,`class`,r.classes.join(` `)),e.setAttributeNS(`http://www.w3.org/2000/svg`,`href`,r.link),e.setAttributeNS(`http://www.w3.org/2000/svg`,`rel`,`noopener`),c===`sandbox`?e.setAttributeNS(`http://www.w3.org/2000/svg`,`target`,`_top`):r.linkTarget&&e.setAttributeNS(`http://www.w3.org/2000/svg`,`target`,r.linkTarget);let t=i.insert(function(){return e},`:first-child`),n=i.select(`.label-container`);n&&t.append(function(){return n.node()});let a=i.select(`.label`);a&&t.append(function(){return a.node()})}}})}},P=(e,t)=>{let n=i,r=n(e,`r`),a=n(e,`g`),o=n(e,`b`);return u(r,a,o,t)},F=e=>`.label {
    font-family: ${e.fontFamily};
    color: ${e.nodeTextColor||e.textColor};
  }
  .cluster-label text {
    fill: ${e.titleColor};
  }
  .cluster-label span,p {
    color: ${e.titleColor};
  }

  .label text,span,p {
    fill: ${e.nodeTextColor||e.textColor};
    color: ${e.nodeTextColor||e.textColor};
  }

  .node rect,
  .node circle,
  .node ellipse,
  .node polygon,
  .node path {
    fill: ${e.mainBkg};
    stroke: ${e.nodeBorder};
    stroke-width: 1px;
  }
  .flowchart-label text {
    text-anchor: middle;
  }
  // .flowchart-label .text-outer-tspan {
  //   text-anchor: middle;
  // }
  // .flowchart-label .text-inner-tspan {
  //   text-anchor: start;
  // }

  .node .katex path {
    fill: #000;
    stroke: #000;
    stroke-width: 1px;
  }

  .node .label {
    text-align: center;
  }
  .node.clickable {
    cursor: pointer;
  }

  .arrowheadPath {
    fill: ${e.arrowheadColor};
  }

  .edgePath .path {
    stroke: ${e.lineColor};
    stroke-width: 2.0px;
  }

  .flowchart-link {
    stroke: ${e.lineColor};
    fill: none;
  }

  .edgeLabel {
    background-color: ${e.edgeLabelBackground};
    rect {
      opacity: 0.5;
      background-color: ${e.edgeLabelBackground};
      fill: ${e.edgeLabelBackground};
    }
    text-align: center;
  }

  /* For html labels only */
  .labelBkg {
    background-color: ${P(e.edgeLabelBackground,.5)};
    // background-color: 
  }

  .cluster rect {
    fill: ${e.clusterBkg};
    stroke: ${e.clusterBorder};
    stroke-width: 1px;
  }

  .cluster text {
    fill: ${e.titleColor};
  }

  .cluster span,p {
    color: ${e.titleColor};
  }
  /* .cluster div {
    color: ${e.titleColor};
  } */

  div.mermaidTooltip {
    position: absolute;
    text-align: center;
    max-width: 200px;
    padding: 2px;
    font-family: ${e.fontFamily};
    font-size: 12px;
    background: ${e.tertiaryColor};
    border: 1px solid ${e.border2};
    border-radius: 2px;
    pointer-events: none;
    z-index: 100;
  }

  .flowchartTitleText {
    text-anchor: middle;
    font-size: 18px;
    fill: ${e.textColor};
  }
`;export{T as a,x as c,E as i,b as l,F as n,D as o,O as r,S as s,N as t};