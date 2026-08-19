# 🐛 버그 리포트 (Bug Report)

## [BUG-001] 피바라기(이벤트 카드) 발동 시 침묵 카드로 무효화되는 문제

- **등록일**: 2026-08-18
- **상태**: 🟡 기록됨 (추후 수정 예정)
- **심각도**: 보통 (게임 룰 불일치)

---

### 1. 현상 요약
* 생존자가 **[피바라기]** 이벤트 카드를 뽑아 대상을 공격할 때, 대상 또는 다른 플레이어가 **[침묵]** 카드를 사용하여 피바라기 발동 자체를 취소/무효화할 수 있는 현상 발생.

### 2. 정상 규칙 (게임 룰)
* **피바라기**는 **이벤트 카드**이며, **침묵**은 **도구(무기/방패/아이템 등) 카드**의 사용을 막거나 무효화하는 카드입니다.
* 따라서 이벤트 카드인 피바라기 자체는 침묵으로 취소/방어할 수 없으며, 이벤트 무효화는 **[긴급탈출키트]**로만 가능해야 합니다.
* *(단, 피바라기 공격을 막기 위해 방어자가 제출한 [방패/반사] 등의 도구 카드를 무효화하는 용도로 침묵을 사용하는 것은 정상 룰에 부합합니다.)*

### 3. 원인 분석 (코드)
* 파일: `server/src/index.ts` (`react_with_item` 이벤트 리스너)
* `item.name === '침묵'` 처리 시, 현재 진행 중인 액션(`room.pendingAction`)이 이벤트 카드인지 도구 공격인지 구분하지 않고 `initiatorId`가 존재하면 무조건 펜딩 타이머를 해제하고 메인 페이즈(`room.returnToMainPhase()`)로 복귀시킴.

```typescript
// server/src/index.ts 중 발췌
} else if (item.name === '침묵') {
  if (room.pendingAction && room.pendingAction.initiatorId) {
    const initiator = room.getPlayerById(room.pendingAction.initiatorId);
    if (initiator && initiator.id !== player.id) {
      if (room.pendingAction.timer) clearTimeout(room.pendingAction.timer);
      player.hand.items.splice(itemIdx, 1);
      room.graveyard.push(item);
      room.recalculateMalice(player);
      initiator.isSilenced = true;
      room.returnToMainPhase(); // ⚠️ 피바라기 등 이벤트 진행 중에도 액션이 통째로 취소됨
      ...
    }
  }
}
```

### 4. 추후 수정 방향 (To-Do)
1. **침묵 대상 액션 제한**: `pendingAction.type` 또는 `pendingAction.eventName`을 확인하여 이벤트 카드(피바라기, 폴터가이스트 등) 발동 자체에 대한 침묵 사용을 차단.
2. **도구 카드 무효화에만 침묵 적용**: 방어자가 방패를 제출했을 때 그 방패를 침묵으로 무효화(패로 회수)시키는 로직으로 정교화.
