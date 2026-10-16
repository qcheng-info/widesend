// The "This site" part of How it works: English → Chinese, French, Spanish, Japanese, Korean.
export const aboutTranslations = {
  'This site': ['本站', 'Ce site', 'Este sitio', 'このサイト', '이 사이트'],
  'This site keeps no record of your transfers.': [
    '本站不保留你的传输记录。',
    'Ce site ne garde aucune trace de vos transferts.',
    'Este sitio no guarda ningún registro de tus transferencias.',
    'このサイトは転送の記録を残しません。',
    '이 사이트는 전송 기록을 남기지 않습니다.',
  ],
  'This site keeps a {days}-day record of transfers and rooms for its operator: IP addresses and countries, transfer codes, display names in rooms, file names, types, sizes and fingerprints, and how many messages were sent — never file or message contents.':
    [
      '本站会为运营者保留 {days} 天的传输和房间记录：IP 地址和国家/地区、传输码、房间里的昵称、文件名、类型、大小和指纹，以及发送了多少条消息——从不记录文件或消息的内容。',
      'Ce site conserve pendant {days} jours un journal des transferts et des salons pour son exploitant : adresses IP et pays, codes de transfert, noms affichés dans les salons, noms, types, tailles et empreintes des fichiers, et nombre de messages envoyés — jamais le contenu des fichiers ni des messages.',
      'Este sitio guarda durante {days} días un registro de transferencias y salas para quien lo administra: direcciones IP y países, códigos de transferencia, nombres visibles en las salas, nombres, tipos, tamaños y huellas de los archivos, y cuántos mensajes se enviaron; nunca el contenido de archivos ni mensajes.',
      'このサイトは運営者のために転送とルームの記録を {days} 日間保存します：IP アドレスと国、転送コード、ルームでの表示名、ファイル名・種類・サイズ・フィンガープリント、送信されたメッセージの数。ファイルやメッセージの内容は記録しません。',
      '이 사이트는 운영자를 위해 전송과 방 기록을 {days}일 동안 보관합니다: IP 주소와 국가, 전송 코드, 방에서의 표시 이름, 파일 이름·형식·크기·지문, 보낸 메시지 수. 파일이나 메시지 내용은 기록하지 않습니다.',
    ],
  'This site keeps a {days}-day record of transfers and rooms for its operator: IP addresses and countries, transfer codes, display names in rooms, file types, sizes and fingerprints, and how many messages were sent — never file or message contents.':
    [
      '本站会为运营者保留 {days} 天的传输和房间记录：IP 地址和国家/地区、传输码、房间里的昵称、文件类型、大小和指纹，以及发送了多少条消息——从不记录文件或消息的内容。',
      'Ce site conserve pendant {days} jours un journal des transferts et des salons pour son exploitant : adresses IP et pays, codes de transfert, noms affichés dans les salons, types, tailles et empreintes des fichiers, et nombre de messages envoyés — jamais le contenu des fichiers ni des messages.',
      'Este sitio guarda durante {days} días un registro de transferencias y salas para quien lo administra: direcciones IP y países, códigos de transferencia, nombres visibles en las salas, tipos, tamaños y huellas de los archivos, y cuántos mensajes se enviaron; nunca el contenido de archivos ni mensajes.',
      'このサイトは運営者のために転送とルームの記録を {days} 日間保存します：IP アドレスと国、転送コード、ルームでの表示名、ファイルの種類・サイズ・フィンガープリント、送信されたメッセージの数。ファイルやメッセージの内容は記録しません。',
      '이 사이트는 운영자를 위해 전송과 방 기록을 {days}일 동안 보관합니다: IP 주소와 국가, 전송 코드, 방에서의 표시 이름, 파일 형식·크기·지문, 보낸 메시지 수. 파일이나 메시지 내용은 기록하지 않습니다.',
    ],
  'Files go straight between devices when they can. Otherwise they pass through this site’s relay encrypted, and are never stored. If its daily relay allowance runs out, new relayed transfers wait for a direct connection or until 00:00 UTC.':
    [
      '文件会尽量在设备之间直接传输。无法直连时，文件会加密后经过本站的中继，且不会被存储。如果当天的中继额度用完，新的中继传输会等待直连，或等到 UTC 时间 00:00。',
      'Les fichiers passent directement d’un appareil à l’autre quand c’est possible. Sinon, ils transitent chiffrés par le relais de ce site et ne sont jamais stockés. Si son quota quotidien de relais est épuisé, les nouveaux transferts relayés attendent une connexion directe ou 00:00 UTC.',
      'Los archivos van directamente entre dispositivos cuando es posible. Si no, pasan cifrados por el relé de este sitio y nunca se almacenan. Si se agota su cuota diaria de relé, las nuevas transferencias por relé esperan una conexión directa o hasta las 00:00 UTC.',
      'ファイルは可能な限りデバイス間で直接送られます。それができない場合は暗号化されたままこのサイトのリレーを通り、保存されることはありません。1 日のリレー枠を使い切ると、新しいリレー転送は直接接続か UTC 0:00 まで待機します。',
      '파일은 가능하면 기기 사이에서 바로 전송됩니다. 그렇지 않으면 암호화된 채로 이 사이트의 릴레이를 거치며 저장되지 않습니다. 하루 릴레이 한도를 다 쓰면 새 릴레이 전송은 직접 연결이나 UTC 00:00까지 기다립니다.',
    ],
  'This is a free public instance for trying WideSend. If you send a lot, please run your own.': [
    '这是一个用来试用 WideSend 的免费公共实例。如果你传输量很大，请自己部署一个。',
    'Ceci est une instance publique gratuite pour essayer WideSend. Si vous envoyez beaucoup, merci d’installer la vôtre.',
    'Esta es una instancia pública gratuita para probar WideSend. Si envías mucho, instala la tuya, por favor.',
    'これは WideSend を試すための無料の公開インスタンスです。大量に送る場合は、ご自身で設置してください。',
    'WideSend를 체험해 볼 수 있는 무료 공개 인스턴스입니다. 많이 보내신다면 직접 설치해 주세요.',
  ],
  'WideSend is open-source software under the Apache-2.0 license.': [
    'WideSend 是基于 Apache-2.0 许可证的开源软件。',
    'WideSend est un logiciel libre sous licence Apache-2.0.',
    'WideSend es software de código abierto con licencia Apache-2.0.',
    'WideSend は Apache-2.0 ライセンスのオープンソースソフトウェアです。',
    'WideSend는 Apache-2.0 라이선스의 오픈 소스 소프트웨어입니다.',
  ],
  'Source code': ['源代码', 'Code source', 'Código fuente', 'ソースコード', '소스 코드'],
} satisfies Record<string, [string, string, string, string, string]>;
