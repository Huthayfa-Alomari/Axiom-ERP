from decimal import Decimal
from math import exp
class RiskEngine:
    MODEL_NAME='axiom-ledger-anomaly'; MODEL_VERSION='1.0.0'
    def assess(self,payload:dict)->dict:
        total=Decimal(payload['total_base_debit']); h=payload['historical']; mean=Decimal(h['source_average_amount']); std=Decimal(h['source_stddev_amount']); dup=int(h['same_reference_count']); findings=[]
        z=abs(total-mean)/std if std>0 else Decimal('0'); nz=min(float(z)/8.0,1.0); ds=min(dup/3.0,1.0); ms=.35 if payload['manual'] else 0.0; cs=min(max(int(payload['line_count'])-2,0)/20.0,1.0)
        if z>=Decimal('4'): findings.append({'code':'AI_AMOUNT_OUTLIER','severity':'warning','explanation':'Journal amount differs materially from historical transactions.'})
        if dup>0: findings.append({'code':'AI_DUPLICATE_PATTERN','severity':'warning','explanation':'Similar business reference exists.'})
        raw=nz*.45+ds*.25+ms*.20+cs*.10; score=1/(1+exp(-6*(raw-.5)))
        return {'score':round(score,6),'findings':findings,'model_name':self.MODEL_NAME,'model_version':self.MODEL_VERSION}
