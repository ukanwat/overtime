# Custom BTTask in C++ (UE 5.4+)

Depth for `unreal-behavior-trees`: writing a custom Behavior Tree task node in C++. Verified
against the Behavior Trees documentation and the `UBTTaskNode` API. Requires the `AIModule`
dependency in `*.Build.cs`.

## Instant task (returns immediately)

```cpp
// BTTask_ClearTarget.h
#pragma once
#include "CoreMinimal.h"
#include "BehaviorTree/BTTaskNode.h"
#include "BTTask_ClearTarget.generated.h"

UCLASS()
class MYGAME_API UBTTask_ClearTarget : public UBTTaskNode
{
    GENERATED_BODY()
public:
    UBTTask_ClearTarget();
    virtual EBTNodeResult::Type ExecuteTask(UBehaviorTreeComponent& OwnerComp,
                                            uint8* NodeMemory) override;

    // Exposes a Blackboard key picker in the BT editor.
    UPROPERTY(EditAnywhere, Category = "Blackboard")
    FBlackboardKeySelector TargetKey;
};
```

```cpp
// BTTask_ClearTarget.cpp
#include "BTTask_ClearTarget.h"
#include "BehaviorTree/BlackboardComponent.h"

UBTTask_ClearTarget::UBTTask_ClearTarget()
{
    NodeName = "Clear Target";
}

EBTNodeResult::Type UBTTask_ClearTarget::ExecuteTask(UBehaviorTreeComponent& OwnerComp,
                                                     uint8* NodeMemory)
{
    if (UBlackboardComponent* BB = OwnerComp.GetBlackboardComponent())
    {
        BB->ClearValue(TargetKey.SelectedKeyName);
        return EBTNodeResult::Succeeded;     // done now
    }
    return EBTNodeResult::Failed;
}
```

`EBTNodeResult::Type` values: `Succeeded`, `Failed`, `Aborted`, `InProgress`.

## Latent task (finishes over time)

Return `InProgress`, then call `FinishLatentTask` when the work completes (e.g. a timer, an
async query, or a delegate callback).

```cpp
EBTNodeResult::Type UBTTask_WaitRandom::ExecuteTask(UBehaviorTreeComponent& OwnerComp,
                                                    uint8* NodeMemory)
{
    AAIController* AICon = OwnerComp.GetAIOwner();
    if (!AICon) return EBTNodeResult::Failed;

    const float Delay = FMath::FRandRange(MinTime, MaxTime);

    // Schedule completion; capture the component so we can finish the right task instance.
    FTimerHandle Handle;
    AICon->GetWorldTimerManager().SetTimer(Handle, FTimerDelegate::CreateLambda(
        [&OwnerComp, this]()
        {
            FinishLatentTask(OwnerComp, EBTNodeResult::Succeeded);   // resumes the tree
        }), Delay, /*loop*/ false);

    return EBTNodeResult::InProgress;        // tree waits on this node until FinishLatentTask
}
```

If a latent task can be aborted by the tree (e.g. a higher-priority branch takes over),
override `AbortTask` to cancel timers/queries and return `EBTNodeResult::Aborted`.

## Reading and writing typed Blackboard values

```cpp
UBlackboardComponent* BB = OwnerComp.GetBlackboardComponent();
AActor* Target  = Cast<AActor>(BB->GetValueAsObject(TargetKey.SelectedKeyName));
FVector Loc     = BB->GetValueAsVector(TEXT("LastKnownLocation"));
BB->SetValueAsBool(TEXT("bIsInvestigating"), true);
```

## Notes

- Set `NodeName` in the constructor so the node reads clearly in the BT graph.
- `OwnerComp.GetAIOwner()` gives the `AAIController`; `GetAIOwner()->GetPawn()` the controlled
  pawn — use these instead of caching world pointers.
- For nodes that need per-instance memory (counters, handles), override `GetInstanceMemorySize`
  and use the `NodeMemory` block; for simple cases, member UPROPERTYs on a non-instanced node
  are shared across all uses, so prefer instance memory or instanced nodes when state matters.
- A custom **Service** subclasses `UBTService` and overrides `TickNode`; a custom **Decorator**
  subclasses `UBTDecorator` and overrides `CalculateRawConditionValue`.
