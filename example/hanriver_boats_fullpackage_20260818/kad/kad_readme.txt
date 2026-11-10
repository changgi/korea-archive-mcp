KARDA 온톨로지 입력 — 한강 강배(江船) 기록 발굴
생성 2026-08-18 · 조선 발견 반영 갱신본

■ 구성
karda_nodes.csv  95행 — record 50 · agent 7 · unit 12 · place 10 · event 16
karda_edges.csv  86행 — 관계마다 basis(근거)와 confidence(신뢰도) 명기
참조 무결성 검증: 미해결 참조 0건 (모든 엣지의 source/target이 노드에 존재)

■ ID 체계
  R001~  1차 조사 기록 (근대·현대 · 국가기록원·국립중앙도서관·NARA·TNA 등)
  L001~  조선 법전 조문 (한국사DB 조선시대법령자료)
  K001~  규장각 원전·대장 (各船圖本·舟橋指南·船案·禁營津船謄錄)
  S001~  조선 실록·등록 기사 (승정원일기·비변사등록)
  A / U / P / E   인물 · 기구 · 장소 · 사건

■ 신뢰도 필터 (그래프 오염 방지)
확정 : API 응답 또는 조문 원문에서 직접 판독됨        → 그래프 수록
높음 : 복수 자료의 정합적 해석. 단일 원문 판독은 아님  → 그래프 수록
부분 : 개연성은 있으나 직접 근거 부족                  → tentative, 그래프 제외 권장
       해당 엣지: K004→L006(船案이 成案 조문의 실물인지), E009→R005, R023→P001

■ 설계 의도 — 두 개의 중심 축
① 규율 축 (기존)
   L003(과적·구조 불이행 처벌) → R001(1909 취체규칙) → R002(1912 경무부령)
   → 서울기록원 IT857126(1959 고시) → R005(1993 시행규칙)
   여기에 재난 노드 E003~E009가 pressure_toward로 접속.
   "사고가 법을 만들고, 법이 배를 규정했다"를 그래프로 검증 가능.

② 동원 축 (신규)
   L006(경강 사선 등록제, 大中小 척량 대장)
   → L015(舟橋 총례: 體大者 징발)
   → E014(적재 한도 800→1000석 상향, 漕船 10척 감축)
   → S001/S003(운송권 배정·차등 시상·손실 보전)
   → S002(특권화와 단속)
   "등록이 징발의 인프라였고, 징발의 대가가 운송권이었다"를 추적 가능.

두 축은 L006과 L003에서 갈라져 A007(舟橋船人)과 P006/P007(노량·동작)에서 다시 만난다.

■ 인물 축 — 鄭民始(A004)
   단일 인물이 4개 국면에 등장하는 드문 사례.
   proposed(E014 적재한도 상향) · headed(U001 주교사) ·
   authored_document_in(K003 주교지남 편차) · abolished_policy_in(S001 보상제 혁파)
   인물 중심 서브그래프를 뽑으면 조선 후기 국가 사업의 인적 집중이 드러난다.

■ 관계어(relation) 신규 추가분
   succeeded_by / abolished_by / specifies_scale_for / assigns_to / sets_quota_for
   posts_official_at / enforced_in / locates / taxes / attached_to / funds
   requisitions_from / compensates / rewards / penalizes / confirms
   relocates_to / enabled_by / variant_of / regulates / contradicted_by
   produced_by / records_ships_at / implements / realizes / penalty_for

   ※ contradicted_by(K003→E016)는 '사료가 사료를 반박'하는 관계다.
     舟橋指南 形便조의 '노량진 최적지'가 1857년 銅雀津 이설로 뒤집혔다.
     연구용 그래프에서는 이런 관계를 별도 색으로 표시할 것을 권장.

■ 미포함 (도달 실패 또는 미판독)
   舟橋指南 賞罰 조의 조문 내용(원본 열람 필요)
   禁營津船謄錄 본문 판독(어휘 수준만 확인, 초서 판독 미실시)
   船案 수록 도(道)별 내역(원문 이미지 미제공)
   도선사업법 비공개 사건철(정보공개청구 대상)

■ 사용 시 주의
confidence='부분' 엣지를 필터링하지 않고 그래프에 넣으면 인과 추론이 왜곡된다.
basis 컬럼은 연구자가 각 관계를 재검증할 수 있도록 남긴 것이며, 삭제하지 말 것.
조선 사료의 번역·해석은 본 보고서의 시역(試譯)이며 표점·교감본 대조를 거치지 않았다.

────────────────────────────────────────────────────────
[3차 확장 · 2026-08-18]  노드 99 → 131 / 엣지 86 → 119
  참조 무결성 0오류 · ID 중복 0

ID 접두 (8종)
  R 23  근현대 기록(1909~1986)
  L 28  조선 법전·편람 조문        ← +12
  S 23  실록·등록·일기 기사         ← +17
  K  5  규장각 원전·대장
  E 16  사건
  U 14  제도 단위                   ← +2
  P 12  장소                        ← +2
  A 10  인물                        ← +3

신규 축 — 執籌 배정 체계(U014)
  이번 확장의 중심 노드. 다음 관계로 연결된다.
    lexical_origin_of    L017(抽籤=시험용어) · L018(執籌=상속분할 용어) → U014
    earliest_attestation S007(1731) → U014          최초 용례
    predates             U014 → U004(주교사)         58년 선행
    only_recorded_in     U014 → L028(度支志 事實)     법전 미수록의 증거
    specifies_formula_for L023 → U014                배3등×읍3등 산식
    enables              U013(量船尺) → U014          재야 나눌 수 있다
    side_effect_of       S009 → U014                 船格徵索
    enforcement_of       S012 → U014                 감사 파직
    abolishes_office     S020 → U014                 1880 직임 혁파
    abolishes            S021 → U014                 1882 선박 혁파
    reports_failure_of   S022 → S021                 임선 산수 불일치
    restoration_refused  S023 → S021                 재설치 불가

신규 관계어
  lexical_origin_of      어휘연원 — 다른 영역 용어가 이 제도로 전용됨
  only_recorded_in       유일수록 — 법전 부재를 표시
  earliest_attestation   최초용례
  predates               선행 — 통념과 반대 방향의 시간 관계
  cross_validates        상호검증 — 두 사료의 수치가 서로를 검증
  construction_method_for 시공법 — 재료표(L019)와 시공법(L022)의 대응
  legal_basis_for        법적근거
  ancestor_of            계보선행 — L026(나루 구조의무) → R001(1909 취체규칙)
  proposal_realized_in   제안실현 — S019(1878) → S021(1882)

시각화 권고
  · U014(執籌 배정 체계)를 중심에 두면 이 조사의 후반부 서사가 한 그래프로 보인다.
  · lexical_origin_of 두 엣지는 그래프 바깥(다른 법 영역)에서 들어오므로 별도 색 권장.
  · contradicted_by(L025→S013)는 기존 contradicted_by(舟橋指南↔1857)와 같은 색으로.
    사료가 사료를, 법이 실행을 반박하는 두 사례가 된다.
