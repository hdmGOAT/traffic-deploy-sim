from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field

ControllerType = Literal["rl", "fixed_time", "random"]


class DemandEntry(BaseModel):
    edge: str
    rate: float = Field(..., gt=0, description="Vehicles per minute")


class DemandSpec(BaseModel):
    entries: List[DemandEntry]


class ControllerSpec(BaseModel):
    type: ControllerType
    model_id: Optional[str] = None
    fixed_time_s: int = 30


class SimulationRequest(BaseModel):
    roadnet_id: str
    demand: DemandSpec
    controller: ControllerSpec
    duration_s: int = Field(900, gt=0)
    seed: Optional[int] = None


class SimulationStatus(BaseModel):
    id: str
    status: str
    created_at: str
    updated_at: str


class SimulationMetrics(BaseModel):
    step: int
    queue_length: int
    throughput: int
    mean_wait_s: float
    reward: float = 0.0
    epsilon: Optional[float] = None
    controller: ControllerType
    intersection_id: Optional[str] = None
    phase_index: int
    vehicles: List[Dict[str, Any]] = Field(default_factory=list)
