from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List
from app.risk_engine import RiskEngine
app=FastAPI(title='Axiom ERP Risk Service',version='1.0.0')
engine=RiskEngine()
class Line(BaseModel):
    account_id:str; account_type:str; debit:str; credit:str; base_debit:str; base_credit:str
class History(BaseModel):
    source_transaction_count:int=0; source_average_amount:str='0'; source_stddev_amount:str='0'; same_reference_count:int=0
class Request(BaseModel):
    journal_id:str; source:str; entry_date:str; total_base_debit:str; line_count:int; manual:bool; historical:History; lines:List[Line]
class Response(BaseModel):
    score:float=Field(ge=0,le=1); findings:list[dict]; model_name:str; model_version:str
@app.get('/health')
def health(): return {'status':'ok'}
@app.post('/v1/risk/journal',response_model=Response)
def assess(req:Request): return engine.assess(req.model_dump())
