// Shared Broker demonstration. Loaded before the host's first inline script.
// Demo reads come from this module only; no identity, profile or native IPC is
// consulted. The host still uses its normal views, map and settings renderer.
(function (global) {
    'use strict';
    var here = new URL(global.location.href);
    var nativeOrigin = here.protocol === 'tauri:' || here.hostname === 'tauri.localhost';
    var active = global.__SKIPI_BROKER_DEMO__ === true || (nativeOrigin && here.searchParams.get('demo') === '1');
    var memory = Object.create(null);
    var language = here.searchParams.get('lang');
    memory['skipi-ui-language'] = language === 'ru' ? 'ru' : 'en';
    var storage = active ? Object.freeze({
        getItem: function (key) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null; },
        setItem: function (key, value) { memory[String(key)] = String(value); },
        removeItem: function (key) { delete memory[String(key)]; }
    }) : null;
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function unavailable() { return new Error('This action is unavailable in Demo. Sign in to work with your team.'); }
    function deny() { return Promise.reject(unavailable()); }
    // Capture one session clock. Navigation and midnight never rebuild dates.
    var started = Math.floor(Date.now() / 60000) * 60000;
    function date(days, minutes) { return new Date(started + days * 86400000 - (minutes || 0) * 60000).toISOString(); }
    var routes = [
        ['Wheat', 6500, 'Constanta', 'Alexandria', 'RO', 'EG'],
        ['Steel coils', 12000, 'Marmara', 'Casablanca', 'TR', 'MA'],
        ['Fertilizer', 18000, 'Rotterdam', 'Lagos', 'NL', 'NG'],
        ['Rice', 8500, 'Kandla', 'Dar es Salaam', 'IN', 'TZ'],
        ['Soybeans', 28000, 'Santos', 'Barcelona', 'BR', 'ES'],
        ['Timber', 4200, 'Riga', 'Hamburg', 'LV', 'DE'],
        ['Cement', 15000, 'Mersin', 'Tema', 'TR', 'GH'],
        ['Wheat', 6500, 'Constanta', 'Mersin', 'RO', 'TR']
    ];
    var cargo = routes.map(function (r, i) {
        return { id: 'demo-cargo-' + (i + 1), title: r[1] + ' MT ' + r[0] + ' (sample)', cargo_type: r[0],
            quantity_mt: r[1], load_port: r[2], disch_port: r[3], load_country: r[4], disch_country: r[5],
            laycan_from: date(2 + i), laycan_to: date(6 + i), first_seen_at: date(0, 10 + i * 20),
            published_at: date(0, 10 + i * 20), status: 'active', description: 'Fictional sample cargo for the Skipi Broker demonstration.' };
    });
    var tonnage = routes.map(function (r, i) {
        return { id: 'demo-tonnage-' + (i + 1), title: 'MV Sample ' + (i + 1), vessel_name: 'MV Sample ' + (i + 1),
            vessel_type: 'Dry bulk', dwt: Math.round(r[1] * 1.12), open_port: r[2], open_country: r[4],
            open_from: date(1 + i), open_to: date(7 + i), first_seen_at: date(0, 15 + i * 20),
            published_at: date(0, 15 + i * 20), status: 'active', description: 'Fictional sample vessel; not available for charter.' };
    });
    cargo[7].id = 'demo-cargo-near-wheat';
    var companies = [
        { id: 'demo-company-larkspur', company_name: 'Larkspur Grain', primary_domain: 'larkspur.example.invalid', role_inference: 'broker-like',
            pattern: 'The same cargo is circulated twice. A separate Mersin enquiry has a different discharge port.',
            pattern_ru: 'Один груз разослан дважды. Отдельный запрос на Мерсин имеет другой порт выгрузки.' },
        { id: 'demo-company-havenline', company_name: 'Havenline Brokers', primary_domain: 'havenline.example.invalid', role_inference: 'broker-like',
            pattern: 'The forward names Larkspur as its source and preserves the cargo terms. Source is stated, not independently verified.',
            pattern_ru: 'Пересылка называет Larkspur источником и сохраняет условия. Источник заявлен, но независимо не проверен.' }
    ];
    var sampleMails = [
        { id: 'demo-mail-001', counterpart_id: companies[0].id, from: 'cargo@larkspur.example.invalid', from_name: 'Larkspur Grain',
            subject: 'Wheat 6,500 MT · Constanta / Alexandria', minutes: 45, group_id: 'demo-group-wheat', position_id: cargo[0].id,
            event: 'Original enquiry', event_ru: 'Исходный запрос',
            body_text: 'Good day,\n\nPlease quote for 6,500 MT wheat in bulk, Constanta to Alexandria. Laycan ' + date(2).slice(0,10) + ' to ' + date(6).slice(0,10) + '.\n\nWe are the cargo declarant in this fictional enquiry. Please advise vessel particulars, loading rate and freight indication. Final cargo documents and terminal acceptance remain to be supplied.\n\nKind regards,\nLarkspur Grain\n\nFictional sample correspondence.' },
        { id: 'demo-mail-002', counterpart_id: companies[0].id, from: 'cargo@larkspur.example.invalid', from_name: 'Larkspur Grain',
            subject: 'Repeat · 6,500 MT wheat Constanta / Alexandria', minutes: 30, group_id: 'demo-group-wheat', position_id: cargo[0].id,
            event: 'Same-sender repeat', event_ru: 'Повтор того же отправителя', reply_to_id: 'demo-mail-001',
            body_text: 'Good day,\n\nRepeating our earlier enquiry: 6,500 MT wheat, Constanta / Alexandria. The quantity, ports and laycan are unchanged. This is the same parcel, not an additional cargo.\n\nPlease revert with suitable tonnage and questions.\nLarkspur Grain' },
        { id: 'demo-mail-003', counterpart_id: companies[1].id, from: 'desk@havenline.example.invalid', from_name: 'Havenline Brokers',
            subject: 'Fwd: Larkspur · wheat 6,500 MT Constanta / Alexandria', minutes: 15, group_id: 'demo-group-wheat', position_id: cargo[0].id,
            event: 'Forward with named source', event_ru: 'Пересылка с указанием источника', reply_to_id: 'demo-mail-001',
            body_text: 'Dear colleagues,\n\nForwarded with source: Larkspur Grain. Their enquiry remains 6,500 MT wheat Constanta / Alexandria, with the same laycan. We are circulating this enquiry as brokers.\n\nPlease confirm vessel availability; do not count this forwarded email as another cargo.\n\nSource: demo-mail-001. This sample does not independently establish authority or availability.\nHavenline Brokers' },
        { id: 'demo-mail-004', counterpart_id: companies[0].id, from: 'cargo@larkspur.example.invalid', from_name: 'Larkspur Grain',
            subject: 'Separate enquiry · wheat Constanta / Mersin', minutes: 5, position_id: cargo[7].id,
            event: 'Similar cargo, different destination', event_ru: 'Похожий груз, другой порт',
            body_text: 'Good day,\n\nA separate 6,500 MT wheat enquiry: Constanta / Mersin. Discharge is Mersin, not Alexandria; this must remain a separate position.\n\nPlease confirm the discharge terminal and draft limit.\nLarkspur Grain' }
    ].map(function (mail) {
        return Object.assign({ folder:'INBOX', to:'broker@sample.example.invalid', cc:'', is_read:false, channel:null,
            position_kind:'cargo', date_received:date(0, mail.minutes), thread_id:mail.reply_to_id || mail.id }, mail);
    });
    companies.push(
        {id:'demo-company-echo',company_name:'Echo Quay',primary_domain:'echo.example.invalid',role_inference:'mixed',pattern:'Two fertilizer repeats arrive ten minutes apart, plus a vessel circulation. Frequency is an observed sample pattern, not a verdict about the sender.',pattern_ru:'Два повтора удобрения приходят с интервалом десять минут, плюс рассылка судна. Частота — наблюдаемый паттерн примера, не оценка отправителя.'},
        {id:'demo-company-tidefold',company_name:'Tidefold Chartering',primary_domain:'tidefold.example.invalid',role_inference:'mixed',pattern:'Cargo and tonnage are recirculated from named sources. Compare the original and forwarded terms before treating them as new positions.',pattern_ru:'Груз и тоннаж пересланы с указанными источниками. Сравните исходные и пересланные условия перед учётом новых позиций.'},
        {id:'demo-company-silverwake',company_name:'Silverwake Agency',primary_domain:'silverwake.example.invalid',role_inference:'mixed',pattern:'An exclusive mandate is claimed, but no supporting authority is shown in these messages. A later circulation also follows a reported withdrawal; both points need clarification.',pattern_ru:'Заявлен эксклюзивный мандат, но подтверждающих полномочия документов в письмах нет. Поздняя рассылка пришла после сообщения об отзыве; оба обстоятельства требуют уточнения.'},
        {id:'demo-company-amber',company_name:'Amber Shoal',primary_domain:'amber.example.invalid',role_inference:'mixed',pattern:'The vessel open window is corrected after a repeat. The latest notice changes availability; the previous window stays visible in the history.',pattern_ru:'Окно открытия судна исправлено после повтора. Последнее уведомление меняет доступность, прежнее окно остаётся в истории.'}
    );
    var minutesById=[240,225,210,180,120,230,220,90,210,35,215,205,190,30,200,195,60,25,175,20,110,80,70,50];
    sampleMails.forEach(function(m,i){m.minutes=minutesById[i];m.date_received=date(0,m.minutes);m.position_ids=[m.position_id];});
    // One circular may name several distinct positions. Counts come from these IDs.
    sampleMails[3].position_ids=[cargo[7].id,cargo[3].id,cargo[4].id,cargo[5].id,cargo[6].id];
    sampleMails[3].body_text += '\n\nOther separate enquiries in this fictional circular:\n'
        + cargo.slice(3,7).map(function(c){return c.quantity_mt+' MT '+c.cargo_type+' · '+c.load_port+' / '+c.disch_port+' · '+c.laycan_from.slice(0,10)+' to '+c.laycan_to.slice(0,10);}).join('\n');
    function addMail(number, companyIndex, subject, body, ids, extra){
        var company=companies[companyIndex], sent=number>=21;
        sampleMails.push(Object.assign({id:'demo-mail-'+String(number).padStart(3,'0'),counterpart_id:company.id,
            from:sent?'broker@sample.example.invalid':'desk@'+company.primary_domain,from_name:sent?'Demo Broker':company.company_name,
            to:sent?'desk@'+company.primary_domain:'broker@sample.example.invalid',cc:'',folder:sent?'SENT':'INBOX',is_read:sent,channel:null,
            subject:subject,body_text:body,position_ids:ids,position_id:ids[0],position_kind:ids[0].indexOf('tonnage')>=0?'tonnage':'cargo',
            date_received:date(0,minutesById[number-1]),thread_id:'demo-thread-'+ids[0]},extra||{}));
    }
    addMail(5,0,'Correction · wheat quantity and laycan','Good day,\n\nPlease amend our Alexandria enquiry: quantity is now 6,800 MT and laycan is '+date(3).slice(0,10)+' to '+date(7).slice(0,10)+'. This replaces the 6,500 MT / earlier window in messages 001–003. Ports and cargo specification remain unchanged.\n\nPlease acknowledge the correction; loading rate remains to be agreed.\nLarkspur Grain',[cargo[0].id],{event:'Quantity and window corrected',event_ru:'Количество и окно исправлены',reply_to_id:'demo-mail-001'});
    addMail(6,4,'Steel coils 12,000 MT · Marmara / Casablanca · mandate claimed','Dear colleagues,\n\n12,000 MT steel coils, Marmara / Casablanca, laycan '+cargo[1].laycan_from.slice(0,10)+' to '+cargo[1].laycan_to.slice(0,10)+'. We claim an exclusive mandate for this enquiry.\n\nNo authority letter or named principal is attached to this sample. Please request confirmation before relying on the claim.\nSilverwake Agency',[cargo[1].id],{event:'Mandate claimed; evidence not shown',event_ru:'Мандат заявлен; подтверждения не показаны'});
    addMail(7,3,'Fwd: Silverwake · 12,000 MT steel coils Marmara / Casablanca','Good day,\n\nRecirculating the Silverwake enquiry: 12,000 MT steel coils, Marmara / Casablanca, same window as their original message. We have no additional authority document.\n\nPlease refer to the named source; this is the same cargo, not another parcel.\nTidefold Chartering',[cargo[1].id],{event:'Recirculation with named source',event_ru:'Повторная рассылка с источником',reply_to_id:'demo-mail-006'});
    addMail(8,1,'Withdrawal reported · Marmara / Casablanca steel','Dear colleagues,\n\nWe relay a withdrawal notice for the Silverwake 12,000 MT steel enquiry. Please remove the parcel from active matching. Any later circulation needs fresh confirmation from the named principal.\n\nThe original mandate evidence has not been supplied in this sample.\nHavenline Brokers',[cargo[1].id],{event:'Withdrawal notice',event_ru:'Уведомление об отзыве',reply_to_id:'demo-mail-006'});
    addMail(9,5,'Fertilizer 18,000 MT · Rotterdam / Lagos','Good day,\n\n18,000 MT fertilizer, Rotterdam / Lagos, laycan '+cargo[2].laycan_from.slice(0,10)+' to '+cargo[2].laycan_to.slice(0,10)+'. Please advise suitable geared bulk tonnage. Product specification and stowage factor are to follow.\nAmber Shoal',[cargo[2].id],{event:'Original enquiry',event_ru:'Исходный запрос'});
    addMail(10,2,'Repeat circulation · fertilizer Rotterdam / Lagos','Dear all,\n\n18,000 MT fertilizer Rotterdam / Lagos, same laycan as Amber Shoal. Repeating the same parcel for wider circulation, with no change to quantity or ports.\nEcho Quay',[cargo[2].id],{event:'Repeated circulation',event_ru:'Повторная рассылка',reply_to_id:'demo-mail-009'});
    tonnage.forEach(function(t,i){t.vessel_name=['MV Aurora Vale','MV Northstar Fern','MV Harbor Finch','MV Solace Reed','MV Juniper Bay','MV Cedar Wind','MV Albatross Elm','MV Meridian Ash'][i];t.title=t.vessel_name;});
    addMail(11,1,'MV Aurora Vale · Constanta open · '+tonnage[0].dwt+' DWT','Good day,\n\nMV Aurora Vale, '+tonnage[0].dwt+' DWT dry bulk, open Constanta '+tonnage[0].open_from.slice(0,10)+' to '+tonnage[0].open_to.slice(0,10)+'. Kindly propose suitable cargo and loading particulars. All vessel details are fictional sample data.\nHavenline Brokers',[tonnage[0].id],{event:'Original vessel notice',event_ru:'Исходное уведомление о судне'});
    addMail(12,3,'Fwd: Havenline · MV Aurora Vale open Constanta','Dear colleagues,\n\nFrom Havenline: MV Aurora Vale, '+tonnage[0].dwt+' DWT, open Constanta on the same dates. Forwarded unchanged; please count one vessel position.\nTidefold Chartering',[tonnage[0].id],{event:'Forward with named source',event_ru:'Пересылка с указанием источника',reply_to_id:'demo-mail-011'});
    addMail(13,4,'MV Northstar Fern · Marmara open','Good day,\n\nMV Northstar Fern, '+tonnage[1].dwt+' DWT, open Marmara '+tonnage[1].open_from.slice(0,10)+' to '+tonnage[1].open_to.slice(0,10)+'. Seeking bulk cargo. This vessel notice does not establish our authority for the separate steel cargo enquiry.\nSilverwake Agency',[tonnage[1].id],{event:'Original vessel notice',event_ru:'Исходное уведомление о судне'});
    addMail(14,2,'Repeat · MV Northstar Fern at Marmara','Dear all,\n\nRepeating MV Northstar Fern, '+tonnage[1].dwt+' DWT, Marmara open. Terms match Silverwake’s original vessel notice. No additional vessel is offered.\nEcho Quay',[tonnage[1].id],{event:'Repeated vessel notice',event_ru:'Повтор уведомления о судне',reply_to_id:'demo-mail-013'});
    addMail(15,5,'MV Harbor Finch · Rotterdam open','Good day,\n\nMV Harbor Finch, '+tonnage[2].dwt+' DWT, open Rotterdam '+tonnage[2].open_from.slice(0,10)+' to '+tonnage[2].open_to.slice(0,10)+'. Please send cargo suggestions.\nAmber Shoal',[tonnage[2].id],{event:'Original vessel notice',event_ru:'Исходное уведомление о судне'});
    addMail(16,5,'Repeat · MV Harbor Finch Rotterdam','Good day,\n\nRepeating our earlier MV Harbor Finch notice: same vessel, '+tonnage[2].dwt+' DWT, same Rotterdam open window. This is a reminder, not new tonnage.\nAmber Shoal',[tonnage[2].id],{event:'Same-sender repeat',event_ru:'Повтор того же отправителя',reply_to_id:'demo-mail-015'});
    addMail(17,5,'Correction · MV Harbor Finch open window moved','Good day,\n\nPlease replace the prior open window for MV Harbor Finch. New window: '+date(6).slice(0,10)+' to '+date(9).slice(0,10)+', Rotterdam. DWT is unchanged. Please reconfirm compatibility with any previously proposed cargo.\nAmber Shoal',[tonnage[2].id],{event:'Open window corrected',event_ru:'Окно открытия исправлено',reply_to_id:'demo-mail-015'});
    addMail(18,2,'Reminder · same 18,000 MT fertilizer Rotterdam / Lagos','Dear all,\n\nA further circulation of the same 18,000 MT fertilizer Rotterdam / Lagos, ten minutes after our previous repeat. No quantity, route or laycan change. Please do not count another parcel.\nEcho Quay',[cargo[2].id],{event:'Second repeat within ten minutes',event_ru:'Второй повтор за десять минут',reply_to_id:'demo-mail-009'});
    addMail(19,1,'Five separate vessel openings · fictional fleet circular','Dear colleagues,\n\nFive separate vessel positions for the sample desk:\n'+tonnage.slice(3).map(function(t){return t.vessel_name+' · '+t.dwt+' DWT · '+t.open_port+' · '+t.open_from.slice(0,10)+' to '+t.open_to.slice(0,10);}).join('\n')+'\n\nEach line is a different fictional vessel. These are not duplicates of Aurora, Northstar or Harbor Finch.\nHavenline Brokers',tonnage.slice(3).map(function(t){return t.id;}),{event:'Five distinct vessel positions',event_ru:'Пять отдельных позиций судов'});
    addMail(20,4,'Late circulation · steel Marmara / Casablanca','Dear colleagues,\n\nCirculating the earlier 12,000 MT steel enquiry again. This message arrives after the sample withdrawal notice and does not explain whether the cargo has reopened. Treat availability and authority as unresolved until clarified.\nSilverwake Agency',[cargo[1].id],{event:'After reported withdrawal; status unresolved',event_ru:'После сообщения об отзыве; статус неясен',reply_to_id:'demo-mail-008'});
    addMail(21,0,'Re: corrected wheat · loading details requested','Thank you for the correction to 6,800 MT and the revised laycan. Please confirm loading rate, terminal draft restriction, stowage factor and documents supporting the enquiry. This is an already-written fictional sent example; no message is sent by Demo.',[cargo[0].id],{event:'Sample clarification request',event_ru:'Пример запроса уточнений',reply_to_id:'demo-mail-005'});
    addMail(22,4,'Re: steel · authority evidence requested','Please identify the principal and supply written scope and expiry of the claimed mandate. These sample messages do not yet establish the authority. Also clarify the circulation after the withdrawal notice. No reply supplying these facts is present in this corpus.',[cargo[1].id],{event:'Authority not established by shown messages',event_ru:'Полномочия не установлены показанными письмами',reply_to_id:'demo-mail-006'});
    addMail(23,1,'Re: steel withdrawal · confirmation requested','Please confirm the source and timing of the withdrawal and advise if any reopening is documented. Until clarified, the sample parcel remains excluded from active matching.',[cargo[1].id],{event:'Withdrawal clarification request',event_ru:'Запрос уточнения отзыва',reply_to_id:'demo-mail-008'});
    addMail(24,5,'Re: Harbor Finch · revised window and specifications','Please confirm the revised Rotterdam open window, vessel draft, crane capacity and latest ETA. We will recheck any proposed cargo against the updated dates.',[tonnage[2].id],{event:'Availability clarification request',event_ru:'Запрос уточнения доступности',reply_to_id:'demo-mail-017'});
    cargo[0].quantity_mt=6800;cargo[0].title='6800 MT Wheat (sample)';cargo[0].laycan_from=date(3);cargo[0].laycan_to=date(7);
    cargo[1].status='withdrawn';tonnage[2].open_from=date(6);tonnage[2].open_to=date(9);
    var groupDefs=[
        ['demo-group-wheat','cargo',cargo[0],[1,2,3],[[5,'revision']]],
        ['demo-group-steel','cargo',cargo[1],[6,7],[[8,'withdrawal'],[20,'stale']]],
        ['demo-group-fertilizer','cargo',cargo[2],[9,10,18],[]],
        ['demo-group-aurora','tonnage',tonnage[0],[11,12],[]],
        ['demo-group-northstar','tonnage',tonnage[1],[13,14],[]],
        ['demo-group-harbor','tonnage',tonnage[2],[15,16],[[17,'revision']]]
    ];
    function mailNumber(n){return sampleMails.filter(function(m){return m.id==='demo-mail-'+String(n).padStart(3,'0');})[0];}
    var duplicateGroups=groupDefs.map(function(g){
        var members=g[3].map(function(n,i){var m=mailNumber(n);m.group_id=g[0];return {id:g[0]+'-occ-'+(i+1),is_canonical:i===0,title:m.subject,posted_by_email:m.from,posted_by_name:m.from_name,first_seen_at:m.date_received,mail_id:m.id,counterpart_id:m.counterpart_id,position_id:g[2].id,event:m.event,event_ru:m.event_ru};});
        var events=g[4].map(function(e){var m=mailNumber(e[0]);m.group_id=g[0];return {type:e[1],mail_id:m.id,counterpart_id:m.counterpart_id,title:m.subject,at:m.date_received};});
        return {id:g[0],case_id:g[0],kind:g[1],strength:'duplicate',size:members.length,duplicate_count:members.length-1,
            unique_senders:new Set(members.map(function(m){return m.posted_by_email;})).size,position_id:g[2].id,
            summary:g[1]==='cargo'?g[2].cargo_type+' · '+g[2].load_port+' → '+g[2].disch_port:g[2].vessel_name+' · '+g[2].open_port,
            position:clone(g[2]),members:members,events:events};
    });
    sampleMails.forEach(function(m){
        var group=duplicateGroups.filter(function(g){return g.position_id===m.position_id;})[0];
        if(group)m.group_id=group.id;
        m.thread_id=m.group_id||('demo-thread-'+m.position_id);
    });
    cargo.concat(tonnage).forEach(function(position){
        var mails=sampleMails.filter(function(m){return m.folder==='INBOX'&&m.position_ids.indexOf(position.id)>=0;}).sort(function(a,b){return a.date_received.localeCompare(b.date_received);});
        position.first_seen_at=mails[0].date_received;position.published_at=mails[0].date_received;
        position.source_mail_ids=mails.map(function(m){return m.id;});
    });
    duplicateGroups.forEach(function(g){g.position=clone(cargo.concat(tonnage).filter(function(p){return p.id===g.position_id;})[0]);});
    companies.forEach(function(company){
        var mails=sampleMails.filter(function(m){return m.counterpart_id===company.id;}).sort(function(a,b){return a.date_received.localeCompare(b.date_received);});
        var incoming=mails.filter(function(m){return m.folder==='INBOX';});
        company.cargo_posts=incoming.reduce(function(n,m){return n+m.position_ids.filter(function(id){return id.indexOf('cargo')>=0;}).length;},0);
        company.tonnage_posts=incoming.reduce(function(n,m){return n+m.position_ids.filter(function(id){return id.indexOf('tonnage')>=0;}).length;},0);
        company.mixed_posts=0;company.total_messages=mails.length;company.incoming_messages=incoming.length;company.sent_messages=mails.length-incoming.length;
        company.first_seen=mails[0].date_received;company.last_seen=mails[mails.length-1].date_received;
        company.evidence_ids=mails.map(function(m){return m.id;});company.top_cargoes='Fictional cargo positions';company.top_routes='See linked source messages';
    });
    companies[0].pattern='The original wheat enquiry is repeated, then explicitly corrected to 6,800 MT and a new window. The separate Mersin parcel stays distinct.';
    companies[0].pattern_ru='Исходный запрос на пшеницу повторён, затем явно исправлен до 6 800 т и нового окна. Отдельная партия на Мерсин не объединяется с ним.';
    companies[1].pattern='Forwarded source, withdrawal notice and vessel circulars are labelled. Read the linked clarification request separately from incoming evidence.';
    companies[1].pattern_ru='Пересылка источника, сообщение об отзыве и рассылка судов подписаны. Отправленный запрос уточнения отделён от входящих сведений.';
    function mailList(folder) {
        if (!active) throw unavailable();
        return clone(sampleMails.filter(function (mail) { return mail.folder === folder; }));
    }
    function mailMessage(id) {
        if (!active) throw unavailable();
        var mail = sampleMails.filter(function (item) { return item.id === id; })[0];
        if (!mail) throw unavailable();
        return clone(mail);
    }
    function markMailRead(id) {
        if (!active) throw unavailable();
        var mail = sampleMails.filter(function (item) { return item.id === id; })[0];
        if (!mail) throw unavailable();
        mail.is_read = true;
    }
    // Synthetic matching receipts use explicit capacity, port and window criteria.
    var pairs=[];
    cargo.filter(function(c){return c.status==='active';}).forEach(function(c){
        tonnage.filter(function(t){return t.status==='active'&&t.open_port===c.load_port&&c.quantity_mt<=t.dwt*0.95&&t.open_from<=c.laycan_to&&t.open_to>=c.laycan_from;}).forEach(function(t){
            pairs.push({id:'demo-pair-'+c.id+'-'+t.id,cargo_signal:c,tonnage_signal:t,
                score:Math.round(100-Math.abs(t.dwt/c.quantity_mt-1)*40),created_at:date(0,5),
                reasons:['Sample capacity: quantity <= 95% DWT','Same load/open port','Overlapping date windows']});
        });
    });
    var matches = pairs.map(function (p, i) {
        return { id: 'demo-match-' + (i + 1), cargo_listing: p.cargo_signal, bazaar_tonnage_signal: p.tonnage_signal,
            bazaar_cargo_signal: p.cargo_signal, score: p.score, created_at: p.created_at, reasons: p.reasons };
    });
    var settings = { broker_id: 'demo-local', bearer_token: '', server_url: '', display_name: 'Sample Chartering (Demo)',
        reply_to: 'broker@sample.example.invalid', team_nickname: 'Demo Broker', chat_sound: false };
    var reads = {
        get_settings: function () { return settings; },
        get_build_info: function () { return { component: 'Broker', component_version: '0.1.152', source_identifier: 'unknown', verification_status: 'unavailable' }; },
        fetch_my_cargo: function () { return cargo.filter(function(p){return p.status==='active';}).slice(0,3); },
        fetch_my_tonnage: function () { return tonnage.slice(0, 3); },
        fetch_matches_inbox: function () { return { own_matches: [], bazaar_matches: matches }; },
        fetch_bazaar_pairs: function () { return pairs; },
        fetch_bazaar_signal_list: function (args) {
            if (args.kind !== 'cargo' && args.kind !== 'tonnage') throw unavailable();
            return (args.kind === 'cargo' ? cargo : tonnage).filter(function(p){return p.status==='active';});
        },
        fetch_bazaar_cross_matches: function () { return pairs; },
        fetch_analytics_flows: function () { return cargo.filter(function(c){return c.status==='active';}).map(function(c){return {top_load_port:c.load_port,top_disch_port:c.disch_port,from_country:c.load_country,to_country:c.disch_country,top_cargo:c.cargo_type,signals:1,total_mt:c.quantity_mt};}); },
        fetch_counterparts: function () { return companies; },
        fetch_counterpart_flags: function () { return []; },
        fetch_duplicate_clusters: function (args) { return duplicateGroups.filter(function (group) { return group.kind === args.kind; }); },
        fetch_mail_inbox: function (args) { return { messages:mailList(args.folder || 'INBOX') }; },
        fetch_mail_message: function (args) { return mailMessage(args.messageId); },
        fetch_case_seeds: function () { return []; },
        fetch_team_messages: function () { return [{ id: 'demo-message', sender_nickname: 'Demo Broker',
            body: 'Welcome! These cargoes and vessels are fictional. Explore the map, matches and other modules.', created_at: date(0, 10) }]; },
        fetch_team_members: function () { return [{ nickname: 'Demo Broker', last_seen_at: date(0) }]; },
        get_mailbox_status: function () { return { configured: true, demo: true, email_masked: 'broker@sample.example.invalid' }; },
        fetch_mail_signal_counts: function () { var counts = {}; sampleMails.forEach(function (mail) { counts[mail.id] = {cargo:mail.position_ids.filter(function(id){return id.indexOf('cargo')>=0;}).length,tonnage:mail.position_ids.filter(function(id){return id.indexOf('tonnage')>=0;}).length}; }); return counts; },
        search_vessels: function () { return []; },
        fetch_vessel: function () { return null; }
    };
    function positionsForMail(id){
        var m=mailMessage(id);
        return clone(cargo.concat(tonnage).filter(function(p){return m.position_ids.indexOf(p.id)>=0;}));
    }
    function listCases(){
        if(!active)throw unavailable();
        return clone(duplicateGroups.map(function(g){return {id:g.id,title:g.summary,kind:g.kind,status:g.position.status};}).concat([{id:'demo-case-cargo-circular',title:'Separate cargo enquiries',kind:'cargo',status:'active'},{id:'demo-case-tonnage-circular',title:'Five vessel openings',kind:'tonnage',status:'active'}]));
    }
    function casePacket(id){
        if(!active)throw unavailable();
        var group=duplicateGroups.filter(function(g){return g.id===id;})[0];
        if(!group&&(id==='demo-case-cargo-circular'||id==='demo-case-tonnage-circular')){
            var circular=mailNumber(id==='demo-case-cargo-circular'?4:19);
            var position=cargo.concat(tonnage).filter(function(p){return p.id===circular.position_id;})[0];
            group={id:id,position:position,summary:id==='demo-case-cargo-circular'?'Separate cargo enquiries':'Five vessel openings',kind:circular.position_kind,size:1,duplicate_count:0,events:[],circular:circular};
        }
        if(!group)throw unavailable();
        var linked=sampleMails.filter(function(m){return m.group_id===id;}).sort(function(a,b){return a.date_received.localeCompare(b.date_received);}).slice(0,7);
        if(group.circular)linked=[group.circular];
        var p=group.position;
        var records=[{id:p.id,kind:group.kind,title:group.summary,quantity_mt:p.quantity_mt||null,dwt:p.dwt||null,
            load_port:p.load_port||null,disch_port:p.disch_port||null,open_port:p.open_port||null,
            window_from:p.laycan_from||p.open_from,window_to:p.laycan_to||p.open_to,status:p.status,provenance:p.source_mail_ids.slice()}];
        linked.forEach(function(m){records.push({id:m.id,kind:'mail',subject:m.subject,from_name:m.from_name,folder:m.folder,
            excerpt:m.body_text.slice(0,1500),at:m.date_received,provenance:[m.id],trust:'untrusted sample content'});});
        var packet={demo:true,corpus_id:'broker-showcase-v1',case_id:id,revision:1,fixture_at:new Date(started).toISOString(),
            title:group.summary,counts:{occurrences:group.size,duplicates:group.duplicate_count,revisions:group.events.filter(function(e){return e.type==='revision';}).length,withdrawals:group.events.filter(function(e){return e.type==='withdrawal';}).length},records:records};
        // Hard bounds apply after serialization too, so fields cannot silently grow.
        if(records.length>8||JSON.stringify(packet).length>12000)throw unavailable();
        return clone(packet);
    }
    function sampleResponse(packet,question,locale){
        var checked=casePacket(packet.case_id),ru=locale==='ru',q=String(question||'').trim().toLowerCase();
        var status=ru?'Пример ответа · демоверсия\n\n':'Sample response · demo preview\n\n';
        if(/duplicate|повтор|дубл/.test(q))return status+(ru?'В этом примере ':'In this sample there are ')+checked.counts.occurrences+(ru?' появления и ':' appearances and ')+checked.counts.duplicates+(ru?' точных повтора. Сравните исходные письма: параметры одной позиции совпадают; исправления и отзыв показаны отдельно.':' exact repeats. Compare the linked source messages: the position terms match; revisions and withdrawal are recorded separately.');
        if(/chang|измен|исправ/.test(q))return status+(checked.counts.revisions?(ru?'В истории есть явное исправление. Последние параметры показаны в карточке выбранного кейса; первоначальные письма сохранены без переписывания. Уточните принятие новых условий.':'The history includes an explicit correction. The selected case shows the latest terms; original messages remain unchanged. Ask whether the revised terms have been acknowledged.'):(ru?'В показанной истории нет явного исправления параметров. Повтор сам по себе не добавляет новую позицию.':'No explicit correction of terms appears in this case history. A repeat does not itself create another position.'));
        if(/mandate|authority|missing|мандат|полномоч|не хватает/.test(q))return status+(ru?'Заявление не заменяет подтверждение. В этих примерах не показаны письменные полномочия, их объём и срок, а также независимое подтверждение принципала. Запросите эти сведения; не делайте вывод о мошенничестве.':'A claim is not evidence of authority. These samples do not show written authority, its scope or expiry, or independent confirmation from the principal. Request those facts; do not infer fraud.');
        if(/question|clarif|draft|вопрос|уточн|состав/.test(q))return status+(ru?'Уточните: кто принципал и как подтверждены полномочия; какие количество и окно действуют сейчас; подтверждены ли ставка погрузки, ограничения терминала и доступность позиции; кем и когда принято последнее исправление или отзыв.':'Ask who the principal is and how authority is evidenced; which quantity and window are current; whether loading rate, terminal limits and availability are confirmed; and who acknowledged the latest correction or withdrawal.');
        return status+(ru?'Здесь доступны подготовленные примеры по выбранному вымышленному кейсу. Выберите вопрос о повторах, изменённых условиях, недостающих полномочиях или уточнениях.':'Prepared examples are available for the selected fictional case. Choose a question about duplicates, changed terms, missing authority or clarifications.');
    }
    function invoke(command, args) {
        if (!active || !Object.prototype.hasOwnProperty.call(reads, command)) return deny();
        try { return Promise.resolve(clone(reads[command](args || {}))); }
        catch (error) { return Promise.reject(error); }
    }
    function enter() {
        if (nativeOrigin) {
            var url = new URL(here.href); url.searchParams.set('demo', '1'); url.hash = '';
            global.location.assign(url.href);
        } else global.location.assign('/app/broker/desktop/demo/');
    }
    function exit() {
        if (nativeOrigin) {
            var url = new URL(here.href); url.searchParams.delete('demo'); url.hash = '';
            global.location.assign(url.href);
        } else global.location.assign('/app/broker/desktop/');
    }

    if (active) {
        var rawFetch = global.fetch;
        var base = global.document.baseURI;
        var geography = ['leaflet/world.geojson', 'leaflet/world-land.geojson', 'leaflet/world-coastline.geojson'].map(function (p) { return new URL(p, base).href; });
        var msi = new URL('msi/warnings.geojson', base).href;
        global.fetch = function (input, options) {
            if (typeof input !== 'string' && !(input instanceof URL)) return deny();
            var url;
            try { url = new URL(String(input), base); } catch (_) { return deny(); }
            if (options && options.method && String(options.method).toUpperCase() !== 'GET') return deny();
            if (url.href === msi) return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ type: 'FeatureCollection', features: [] }); } });
            if (geography.indexOf(url.href) < 0 || typeof rawFetch !== 'function') return deny();
            return rawFetch.call(global, url.href, { method: 'GET', credentials: 'omit', redirect: 'error' });
        };
        // No alternate network transport can turn a local Demo action into a
        // server request. Native commands are separately selected by the host.
        ['XMLHttpRequest', 'WebSocket', 'EventSource'].forEach(function (key) {
            global[key] = function () { throw unavailable(); };
        });
        global.open = function () { return null; };
        if (global.navigator && global.navigator.sendBeacon) global.navigator.sendBeacon = function () { return false; };
        global.document.addEventListener('submit', function (event) { event.preventDefault(); }, true);
        global.document.addEventListener('click', function (event) {
            var link = event.target && event.target.closest && event.target.closest('a[href]');
            if (link) { event.preventDefault(); try { global.showToast(unavailable().message, 'info'); } catch (_) {} }
        }, true);
    }
    Object.defineProperty(global, 'SkipiBrokerDemo', { value: Object.freeze({ active: active, storage: storage, invoke: invoke, enter: enter, exit: exit,
        mailList:mailList, mailMessage:mailMessage, markMailRead:markMailRead, listCases:listCases, casePacket:casePacket, sampleResponse:sampleResponse, positionsForMail:positionsForMail }), writable: false, configurable: false });
})(window);
