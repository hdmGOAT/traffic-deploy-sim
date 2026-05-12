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
    training_fraction: float = Field(0.25, gt=0.0, le=1.0)
    seed: Optional[int] = None
    gamma: float = Field(0.95, ge=0.0, le=1.0)
    learning_rate: float = Field(0.001, gt=0)
    epsilon_start: float = Field(1.0, ge=0.0, le=1.0)
    epsilon_end: float = Field(0.1, ge=0.0, le=1.0)
    epsilon_decay: float = Field(0.997, gt=0)
    batch_size: int = Field(32, gt=0)
    hidden_dim: int = Field(64, gt=0)
    replay_capacity: int = Field(5000, gt=0)
    learning_starts: int = Field(100, ge=0)
    target_update_interval: int = Field(100, gt=0)
    train_frequency: int = Field(1, gt=0)


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
    policy_mode: Optional[str] = None
    controller: ControllerType
    intersection_id: Optional[str] = None
    phase_index: int
    vehicles: List[Dict[str, Any]] = Field(default_factory=list)
